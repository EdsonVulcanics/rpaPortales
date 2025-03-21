const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin())
const mysql = require('mysql2/promise'); // Use the mysql2 package for MySQL interaction
const { exec } = require('child_process');
const fs = require('fs');

require('dotenv').config();

const path = require('path');
const headlessEnv = true
const screenshotPath = path.resolve(__dirname, 'screenshots.jpg'); // Define screenshot directory

// MySQL database configuration
const dbConfig = {
    user: 'vulcan',
    password: '$Vulcanics24.',
    host: '159.223.100.31',
    database: 'portales',
    port: 3306
};

// Function to store or update CURP data in the database
async function storeCurpData(curp, updates) {
    try {
        // Establish a connection to the MySQL database
        const conn = await mysql.createConnection(dbConfig);

        // Prepare the SQL query for inserting or updating the CURP data
        const query = `
            INSERT INTO curp_data (curp, data, status, file_data)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                data = VALUES(data),
                status = VALUES(status),
                file_data = VALUES(file_data)
        `;

        // Use null values as defaults for optional fields (data, file_data)
        const { data = null, status = 'processing', file_data = null } = updates;

        // Execute the SQL query
        await conn.execute(query, [curp, JSON.stringify(data), status, file_data]);

        console.log(`CURP data for ${curp} successfully updated with status: ${status}`);

        // Close the database connection
        await conn.end();
    } catch (err) {
        console.error(`Error storing CURP data in the database for ${curp}:`, err);
        throw new Error('Database insertion failed');
    }
}


// Function to wait for the file to finish downloading
const waitForFileToBeDownloaded = (filePath, timeout = 30000) => {
    const startTime = Date.now();
    let lastSize = 0;

    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                const currentSize = stats.size;

                // If the file size hasn't changed for 2 consecutive checks, we assume the download is complete
                if (currentSize === lastSize && currentSize > 0) {
                    clearInterval(interval);
                    resolve();
                }

                lastSize = currentSize;
            }

            // If the timeout is reached, reject the promise
            if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error("File download timed out"));
            }
        }, 1000); // Check every second
    });
};

const processCurp = async (curp) => {
    if (!curp || curp.length !== 18) {
        return { status: 'error', message: 'CURP has to be 18 characters long' };
    }

    const downloadDirectory = path.resolve(__dirname, 'downloads');
    const pdfFilename = `CURP_${curp}.pdf`;
    const pdfPath = path.join(downloadDirectory, pdfFilename);

    let browser;

    browser = await puppeteer.launch({
        headless: headlessEnv,
        args: [
            '--ignore-certificate-errors',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-setuid-sandbox',

            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-features=site-per-process',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-blink-features=AutomationControlled', // Disable automation detection
            '--use-gl=egl', // Use OpenGL backend on Linux
            '--headless=new', // Use the new headless mode
            '--hide-scrollbars', // Hide scrollbars like a real browser
        ]
    });

    try {
        const pages = await browser.pages();

        const page = pages[0];
        await page.setViewport({
            width: 1280,  // Set your desired width
            height: 800,  // Set your desired height
            deviceScaleFactor: 1, // Optional, for retina screens
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        await page.evaluateOnNewDocument(() => {
            const getParameter = WebGLRenderingContext.prototype.getParameter;

            WebGLRenderingContext.prototype.getParameter = function (parameter) {
                // Spoof WebGL Renderer
                if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
                    return 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)';
                }
                // Spoof WebGL Vendor
                if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
                    return 'AMD';
                }
                return getParameter(parameter);
            };
        });

        await page.setRequestInterception(true);

        page.on('request', async (request) => {
            const blockedResources = ['image', 'media', 'font', 'stylesheet'];
            const url = request.url();

            if (blockedResources.includes(request.resourceType()) || url.includes('https://analytics.google.com/g/collect')) {
                request.abort(); // Block the resource
            } else {
                request.continue(); // Allow the request to proceed
            }
        });

        await page.goto('https://www.google.com', { waitUntil: 'networkidle0' });
        await page.type('textarea[name="q"]', 'CURP site');
        await page.keyboard.press('Enter');
        await page.waitForSelector('h3');
        await page.click('a[href*="gob.mx/curp"] h3');
        await page.waitForNavigation({ waitUntil: 'networkidle0' });

        // Step 2: Input CURP and search
        await page.waitForSelector('#curpinput', { timeout: 10000 });
        await page.type('#curpinput', curp);
        await page.waitForSelector('#searchButton', { visible: true, timeout: 10000 });

        // Step 2: Retry waiting for the results table up to 3 times
        let attempts = 0;
        const maxRetries = 3;
        const timeout = 30000;
        let selectorFound = false;

        while (attempts < maxRetries && !selectorFound) {
            try {
                await page.click('#searchButton');

                // Step 3: Create a race condition between waiting for the table or the error message
                const result = await Promise.race([
                    page.waitForSelector("div.panel.panel-default table", { timeout }), // Wait for results table
                    page.waitForSelector("div.alert.alert-danger", { timeout })         // Wait for error message
                ]);

                if (result) {
                    const isError = await result.evaluate((el) =>
                        el.classList.contains('alert-danger')
                    );

                    if (isError) {
                        console.log('Error message detected');
                        await storeCurpData(curp, { data: null, status: 'failed', file_data: null });

                        return { status: 'failed', message: 'CURP processing failed' };
                    }

                    console.log('Results table detected');
                    selectorFound = true;  // Exit the loop if selector is found
                }
            } catch (error) {
                attempts++;
                try {
                    const page = (await browser.pages())[0]; // Get the current page
                    await page.screenshot({ path: screenshotPath, fullPage: true });
                    console.log(`Screenshot saved at ${screenshotPath}`);
                } catch (screenshotError) {
                    console.error('Error taking screenshot:', screenshotError);
                }
                console.log(`Attempt ${attempts} failed. Retrying...`);
                // Focus on the input field
                await page.click('#curpinput');

                // Select all the text in the input field
                await page.keyboard.down('Control'); // If you are on macOS, change 'Control' to 'Meta'
                await page.keyboard.press('A');
                await page.keyboard.up('Control');

                // Delete the selected text
                await page.keyboard.press('Backspace');

                // Type the new value
                await page.type('#curpinput', curp);
                if (attempts >= maxRetries) {
                    throw new Error(`Failed to find selector after ${maxRetries} attempts.`);
                }
            }
        }

        const result = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("div.panel.panel-default table tr"));
            const data = {};
            rows.forEach(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length === 2) {
                    const key = cells[0].innerText.trim().replace(':', '');
                    const value = cells[1].innerText.trim();
                    data[key] = value;
                }
            });
            return data;
        });

        await page.waitForSelector('#download', { visible: true, timeout: 10000 });
        await page._client().send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadDirectory
        });

        await page.click('#download');

        await waitForFileToBeDownloaded(pdfPath, 30000); // Wait for up to 30 seconds

        // Step 4: Convert PDF to PNG
        const base64Png = await convertPdfToPng(pdfPath);

        await storeCurpData(curp, { data: result, status: 'completed', file_data: base64Png });

        // Return success
        return { status: 'success', message: 'CURP processed successfully' };


    } catch (error) {
        console.error(`Error processing CURP: ${error}`);
        await storeCurpData(curp, { status: 'failed' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

const convertPdfToPng = async (pdfPath) => {
    const outputDir = path.dirname(pdfPath);
    const pngFilenamePrefix = path.basename(pdfPath, '.pdf');
    const generatedPngPath = path.join(outputDir, `${pngFilenamePrefix}.png`);

    return new Promise((resolve, reject) => {
        // Use pdftocairo to convert the first page of the PDF to PNG
        const command = `pdftocairo -png -singlefile -f 1 -l 1 "${pdfPath}" "${generatedPngPath}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error during PDF to PNG conversion: ${error.message}`);
                reject(error);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }

            // Read the generated PNG file and convert it to base64
            const pngFile = fs.readFileSync(`${generatedPngPath}.png`);
            const base64Png = pngFile.toString('base64');

            resolve(base64Png);
        });
    });
};


const getCurpData = async (req, res) => {
    const curp = req.headers['curp'];

    if (!curp || curp.length !== 18) {
        return res.status(400).json({ message: 'CURP must be 18 characters long' });
    }

    try {
        // Establish a connection to the database
        const connection = await mysql.createConnection(dbConfig);

        // Query the database for the CURP data
        const [rows] = await connection.execute('SELECT * FROM curp_data WHERE curp = ?', [curp]);

        // Close the database connection
        await connection.end();

        if (rows.length === 0) {
            // If no data is found for the CURP, return a 404 error
            return res.status(404).json({ message: 'No data found for the provided CURP' });
        }

        const curpData = rows[0].data;
        const status = rows[0].status;

        if (status === 'failed') {
            // If the status is 'failed', return a 200 status with a specific message
            return res.status(200).json({ message: 'El proceso de consulta falló' });
        }

        if (!curpData) {
            // If the data is null, return the status instead
            return res.status(400).json({ status });
        }

        // Return the data if it exists
        return res.status(200).json(curpData);

    } catch (error) {
        console.error('Error fetching CURP data:', error.message);
        return res.status(500).json({ message: 'Error fetching CURP data' });
    }
};



const getCurpPng = async (req, res) => {
    const curp = req.headers['curp'];

    if (!curp || curp.length !== 18) {
        return res.status(400).json({ message: 'CURP must be 18 characters long' });
    }

    try {
        // Establish a connection to the MySQL database
        const connection = await mysql.createConnection(dbConfig);

        // Query the database for the CURP's PNG file_data (base64)
        const [rows] = await connection.execute('SELECT file_data FROM curp_data WHERE curp = ?', [curp]);

        // Close the database connection
        await connection.end();

        if (rows.length === 0 || !rows[0].file_data) {
            // If no file data is found, return a 404 error
            return res.status(404).json({ message: 'No PNG file found for the provided CURP' });
        }

        // Ensure the base64 PNG data is a string
        let base64Png = rows[0].file_data;

        // If base64Png is a buffer, convert it to a string
        if (Buffer.isBuffer(base64Png)) {
            base64Png = base64Png.toString('utf-8');
        }

        // Remove the data URL prefix if it exists (sometimes tools include this)
        const cleanedBase64 = base64Png.replace(/^data:image\/png;base64,/, '');

        // Convert base64 to binary data (Buffer)
        const pngBuffer = Buffer.from(cleanedBase64, 'base64');

        // Send the PNG as a file response with the appropriate headers
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename=CURP_${curp}.png`);
        return res.status(200).send(pngBuffer);

    } catch (error) {
        console.error('Error fetching CURP PNG file:', error.message);
        return res.status(500).json({ message: 'Error fetching CURP PNG file' });
    }
};



module.exports = { processCurp, getCurpData, storeCurpData, getCurpPng };
