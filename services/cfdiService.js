const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


puppeteer.use(StealthPlugin());

const headlessEnv = true;
const MAX_RETRIES = 3;

const processCfdi = async (url, retryCount = 0) => {
    
    let imagePath;
    
    if (retryCount > MAX_RETRIES) {
        return { status: 'error', message: `Maximum retries (${MAX_RETRIES}) exceeded. Failed to process CFDI.` };
    } try {
        const browser = await puppeteer.launch({
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
        console.log("Browser launched", browser);

        const pages = await browser.pages();
        const page = pages[0];
        console.log("Page loaded", page);

        // Page setup
        await page.setViewport({
            width: 1280,
            height: 800,
            deviceScaleFactor: 1,
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        await page.goto(url);

        // Wait for CAPTCHA image to load //ctl00_MainContent_ImgCaptcha
        const captchaSelector = '#ctl00_MainContent_ImgCaptcha';
        console.log("Waiting for CAPTCHA image to load", captchaSelector);
        await page.waitForSelector(captchaSelector);
        console.log("CAPTCHA image loaded");
        // Get the CAPTCHA image URL
        const captchaUrl = await page.$eval(captchaSelector, img => img.src);
        console.log("CAPTCHA image URL", captchaUrl);
        // Download CAPTCHA image
        const captchaResponse = await axios.get(captchaUrl, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(captchaResponse.data).toString("base64");
        // imagePath = `captcha_${Date.now()}.png`;
        // fs.writeFileSync(imagePath, Buffer.from(captchaResponse.data)); // Save the CAPTCHA image locally
        // console.log("CAPTCHA image downloaded", imagePath);
        // Use FormData to upload the file
  
        // Send the image to the TensorFlow API for solving
        const captchaSolveResponse = await analyzeImage(base64Image);
        console.log("CAPTCHA solved", captchaSolveResponse);

        const captchaText = captchaSolveResponse;

        // Fill in the CAPTCHA on the website
        await page.type('#ctl00_MainContent_TxtCaptchaNumbers', captchaText);
        await page.click('#ctl00_MainContent_BtnBusqueda');

        // Wait for either the results or the error message
        try {
            await page.waitForSelector('#DivContenedor', { timeout: 8000 }); // Wait for results table (success)
        } catch (e) {
            // If #DivContenedor doesn't appear, check if the error is present
            const errorSelector = '#ctl00_MainContent_VsResumenErrores';
            const isErrorVisible = await page.$(errorSelector);

            if (isErrorVisible) {
                // Extract the error message
                const errorMessage = await page.$eval(errorSelector, el => el.innerText);
                await browser.close();
                return { status: 'error', message: `CFDI Error: ${errorMessage.trim()}` };
            } else {
                throw new Error('Unexpected error while waiting for results.');
            }
        }


        // Extract data from the page after solving the CAPTCHA and table loads
        const result = await page.evaluate(() => {
            return {
                rfc_emisor: document.querySelector('#ctl00_MainContent_LblRfcEmisor').innerText,
                nombre_emisor: document.querySelector('#ctl00_MainContent_LblNombreEmisor').innerText,
                rfc_receptor: document.querySelector('#ctl00_MainContent_LblRfcReceptor').innerText,
                nombre_receptor: document.querySelector('#ctl00_MainContent_LblNombreReceptor').innerText,
                folio_fiscal: document.querySelector('#ctl00_MainContent_LblUuid').innerText,
                fecha_expedicion: document.querySelector('#ctl00_MainContent_LblFechaEmision').innerText,
                fecha_certificacion: document.querySelector('#ctl00_MainContent_LblFechaCertificacion').innerText,
                pac_certifico: document.querySelector('#ctl00_MainContent_LblRfcPac').innerText,
                total_cfdi: document.querySelector('#ctl00_MainContent_LblMonto').innerText,
                efecto_comprobante: document.querySelector('#ctl00_MainContent_LblEfectoComprobante').innerText,
                estado_cfdi: document.querySelector('#ctl00_MainContent_LblEstado').innerText,
                estatus_cancelacion: document.querySelector('#ctl00_MainContent_LblEsCancelable')?.innerText || 'N/A',
                fecha_cancelacion: document.querySelector('#ctl00_MainContent_LblFechaCancelacion')?.innerText || 'N/A',
                motivo_cancelacion: document.querySelector('#ctl00_MainContent_lblMotivo')?.innerText || 'N/A',
                folio_sustitucion: document.querySelector('#ctl00_MainContent_lblFolioSustitucion')?.innerText || 'N/A',
            };
        });

        await browser.close();

        // Clean up the downloaded CAPTCHA image
        try {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath); // Delete the file
            }
        } catch (cleanupError) {
            console.error(`Failed to delete CAPTCHA image: ${imagePath}`, cleanupError.message);
        }

        return { status: 'success', data: result };
    } catch (error) {
        console.error(`Error processing CFDI on attempt ${retryCount + 1}:`, error.message);

        if (browser)
            await browser.close();

        // Clean up the downloaded CAPTCHA image
        try {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath); // Delete the file
            }
        } catch (cleanupError) {
            console.error(`Failed to delete CAPTCHA image: ${imagePath}`, cleanupError.message);
        }


        // Retry the process
        return processCfdi(url, retryCount + 1);
    }
};


async function analyzeImage(base64Image) {
    try {
        const response = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "¿Qué texto aparece en esta imagen de captcha? Solo responde con el texto tal cual.",
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${base64Image}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 50,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
          }
        );
      
        console.log("Texto detectado:", response.data.choices[0].message.content);
        return response.data.choices[0].message.content;
        
    } catch (error) {
        console.error("Error OpenAI:", {
            message: error.message,
            details: error.response?.data || 'No additional details',
            status: error.response?.status
        });
        return null;
    }
    
  }

module.exports = { processCfdi };

