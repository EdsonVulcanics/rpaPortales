const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const uuid = require('uuid');

// Enable headless mode for Puppeteer
const headlessEnv = true;

// MySQL database configuration
const dbConfig = {
    user: 'vulcan',
    password: '$Vulcanics24.',
    host: '159.223.100.31',
    database: 'portales',
    port: 3306
};

// Function to store or update the INE request status and data in the database
const storeIneRequest = async (id, status, data = null) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const query = `
            INSERT INTO ine_data (id, status, data)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE status = VALUES(status), data = VALUES(data), updated_at = CURRENT_TIMESTAMP
        `;
        await conn.execute(query, [id, status, data ? JSON.stringify(data) : null]);
        await conn.end();
    } catch (err) {
        console.error('Error storing INE data:', err);
    }
};

// Extract CIC and ID from the URL
const extractCicAndId = (url) => {
    const firstSegment = url.split('/')[3];
    const cic = firstSegment.slice(-9);
    const idCiudadano = firstSegment.slice(4, 13);
    return { cic, idCiudadano };
};

// Process INE request asynchronously
const processIne = async (url) => {
    const { cic, idCiudadano } = extractCicAndId(url);
    const id = cic + idCiudadano;

    const maxRetries = 20;
    let retries = 0;
    let browser;

    // Create a temporary folder for storing audio files
    const tempFolderPath = path.resolve(__dirname, 'temp_audio');

    // Ensure the temp folder exists
    if (!fs.existsSync(tempFolderPath)) {
        fs.mkdirSync(tempFolderPath);
    }

    while (retries < maxRetries) {
        try {
            // Launch Puppeteer
            browser = await puppeteer.launch({
                headless: headlessEnv,
                args: [
                    '--ignore-certificate-errors',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-background-networking',
                    '--proxy-server=mx.smartproxy.com:20000',
                ]
            });

            const pages = await browser.pages();
            const page = pages[0];

            // Authenticate with the proxy
            await page.authenticate({
                username: 'spkjg9luq1',
                password: 'hWwNZms0mvxAn_757o'
            });

            // Set user agent and spoof properties
            await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            await page.setRequestInterception(true);

            page.on('request', async (request) => {
                const blockedResources = ['image', 'media', 'font'];
                const url = request.url();

                if (blockedResources.includes(request.resourceType()) || url.includes('https://analytics.google.com/g/collect')) {
                    request.abort(); // Block the resource
                } else {
                    request.continue(); // Allow the request to proceed
                }
            });

            // Navigate to the INE form page
            await page.goto('https://listanominal.ine.mx/scpln/', {
                waitUntil: 'networkidle0',
                timeout: 60000 // Set the timeout to 60 seconds (60000 milliseconds)
            });

            // Remove extra iframes with the same title, keeping the first of each
            await page.evaluate(() => {
                const captchaIframes = [...document.querySelectorAll('iframe')];

                // Track if we have already kept one of each type
                let recaptchaFound = false;
                let desafioFound = false;
                let desafioFound1 = false;

                captchaIframes.forEach(iframe => {
                    if (iframe.title === 'reCAPTCHA') {
                        if (recaptchaFound) {
                            iframe.remove(); // Remove additional 'reCAPTCHA' iframes
                        } else {
                            recaptchaFound = true; // Keep the first 'reCAPTCHA'
                        }
                    }
                    else if (iframe.title === 'el desafío de recaptcha caduca dentro de dos minutos') {
                        if (desafioFound && desafioFound1) {
                            iframe.remove(); // Remove additional 'el desafío' iframes
                        } else if (!desafioFound) {
                            iframe.remove(); // Remove additional 'el desafío' iframes
                            desafioFound = true; // Keep the first 'el desafío'
                        } else {
                            desafioFound1 = true; // Keep the first 'el desafío'
                        }
                    }
                });
            });

            // Fill out the CIC and ID form fields
            await page.type('#cic', cic);
            await page.type('#idCiudadano', idCiudadano);

            // Solve the CAPTCHA
            const recaptchaFrameElement = await page.waitForSelector('iframe[title="reCAPTCHA"]');
            const recaptchaFrame = await recaptchaFrameElement.contentFrame();
            const checkbox = await recaptchaFrame.waitForSelector('#recaptcha-anchor', { visible: true });
            await checkbox.click();

            // Wait for the challenge frame and switch to it
            const challengeFrameElement = await page.waitForSelector('iframe[title="el desafío de recaptcha caduca dentro de dos minutos"]', { timeout: 15000 });

            if (!challengeFrameElement) throw new Error('Challenge frame not found');

            const challengeFrame = await challengeFrameElement.contentFrame();
            const audioButton = await challengeFrame.waitForSelector('#recaptcha-audio-button', { visible: true });
            await audioButton.click();

            // Extract the audio source URL
            const audioSourceElement = await challengeFrame.waitForSelector('#audio-source');
            const audioUrlHandle = await audioSourceElement.getProperty('src');
            const audioUrl = await audioUrlHandle.jsonValue();

            // Generate a UUID for the audio file
            const audioFileName = `${uuid.v4()}.mp3`;
            const audioFilePath = path.resolve(tempFolderPath, audioFileName);

            const audioResponse = await axios({
                method: 'GET',
                url: audioUrl,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(audioFilePath);
            audioResponse.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // Send the audio to Whisper API to transcribe it
            const whisperResponse = await axios.post('', {
                file: fs.createReadStream(audioFilePath)
            }, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });

            const transcribedText = whisperResponse.data.captcha_text;

            // Enter the transcribed text into the audio response input field
            const audioInput = await challengeFrame.waitForSelector('#audio-response', { visible: true });
            await audioInput.type(transcribedText);

            // Submit the audio challenge response
            const verifyButton = await challengeFrame.waitForSelector('#recaptcha-verify-button', { visible: true });
            await verifyButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Submit the form
            await page.evaluate(() => document.querySelector('#formEFGH').submit());
            
            //await page.waitForSelector('table.table-bordered.lead', { timeout: 60000 });

            const result = await Promise.race([
                page.waitForSelector('table.table-bordered.lead', { timeout: 60000 })
                    .then(() => ({ status: 'success' })),
                page.waitForSelector('div.col-md-12.text-center.p-t-10.p-b-10', { timeout: 60000 })
                    .then(async () => {
                        // Check if the specific error message exists in this element
                        const errorMessage = await page.$eval('div.col-md-12.text-center.p-t-10.p-b-10', el => el.innerText);
                        return {
                            status: 'failed',
                            message: 'INE format is invalid',
                            data: { error: errorMessage.trim() },
                        };
                    })
            ]);

            if (result.status === 'failed') {
                // Store the result in the database and mark the status as "completed"
                await storeIneRequest(id, 'failed', result.data);

                // After successful processing, delete the audio file and the temp folder
                fs.unlinkSync(audioFilePath); // Delete the audio file

                // Optionally, delete the folder after use
                fs.rmdirSync(tempFolderPath, { recursive: true });
                // If we detect the error case, return or handle it
                return result;
            }
            // Scrape the table data from the result page
            const resultData = await page.evaluate(() => {
                // Get table data
                const rows = Array.from(document.querySelectorAll('table.table-bordered.lead tr'));
                const data = {};
                rows.forEach(row => {
                    const columns = row.querySelectorAll('td');
                    const label = columns[0].innerText.trim();
                    const value = columns[1].innerText.trim();
                    data[label] = value;
                });

                // Get additional information from the specific <div> with status messages
                const statusContainer = document.querySelector('div.col-md-7');
                if (statusContainer) {
                    const statusMessage = statusContainer.querySelector('h4').innerText.trim();
                    const additionalInfo = statusContainer.querySelector('p.lead').innerText.trim();
                    const validityDate = statusContainer.querySelector('h4 mark').innerText.trim();

                    // Combine all three into one "Vigencia" field
                    data['Vigencia'] = `${statusMessage} ${additionalInfo} ${validityDate}`;
                }

                return data;
            });

            // Store the result in the database and mark the status as "completed"
            await storeIneRequest(id, 'completed', resultData);

            // After successful processing, delete the audio file and the temp folder
            fs.unlinkSync(audioFilePath); // Delete the audio file

            // Optionally, delete the folder after use
            fs.rmdirSync(tempFolderPath, { recursive: true }); // Remove the folder if desired

            return {
                status: 'success',
                message: 'INE processed successfully',
                data: resultData
            };

        } catch (error) {
            retries++;
            console.error(`Retry ${retries}/${maxRetries} failed:`, error.message);
            if (retries >= maxRetries) {
                // Mark the request as failed in the database
                await storeIneRequest(id, 'failed');
                // Clean up: delete the temp folder if retries are exhausted
                if (fs.existsSync(tempFolderPath)) {
                    fs.rmdirSync(tempFolderPath, { recursive: true });
                }
                return { status: 'error', message: `Failed after ${maxRetries} attempts` };
            }
        } finally {
            if (browser) await browser.close();
        }
    }
};

const getIneData = async (req, res) => {
    const id = req.headers['id'];

    if (!id) {
        return res.status(400).json({ message: 'Y la id bro?' });
    }

    try {
        // Establish a connection to the database
        const connection = await mysql.createConnection(dbConfig);

        // Query the database for the INE data using the id (cic + idCiudadano)
        const [rows] = await connection.execute('SELECT * FROM ine_data WHERE id = ?', [id]);

        // Close the database connection
        await connection.end();

        if (rows.length === 0) {
            // If no data is found for the ID, return a 404 error
            return res.status(404).json({ message: 'No data found for the provided ID' });
        }

        const { data, status } = rows[0];

        // If the status is 'failed', return a 200 status with a specific message
        if (status === 'failed') {
            return res.status(200).json({ message: 'El proceso de consulta falló' });
        }

        // If data is null or empty, return the Status
        if (!data) {
            return res.status(400).json({ status: status });
        }

        // Return data if it exists
        return res.status(200).json(data);

    } catch (error) {
        // Log error and return a 500 error response
        console.error('Error fetching INE data:', error.message);
        return res.status(500).json({ message: 'Error fetching INE data' });
    }
};




module.exports = { processIne, extractCicAndId, getIneData, storeIneRequest };
