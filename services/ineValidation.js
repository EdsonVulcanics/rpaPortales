const { request, response } = require("express");
require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const uuid = require("uuid");
const port=3691;
const tempFolderPath = path.resolve(__dirname, "temp_audio");

// Usar el plugin stealth para evitar detección
puppeteer.use(StealthPlugin());
const headlessEnv = true; // Cambiar a false
//Transcribir audio a texto

let dataResponse;
const transcribirAudio = async (audioUrl) => {
  try {
    // Generate a UUID for the audio file
    const audioFileName = `${uuid.v4()}.mp3`;
    const audioFilePath = path.resolve(tempFolderPath, audioFileName);

    const audioResponse = await axios({
      method: "GET",
      url: audioUrl,
      responseType: "stream",
    });

    const writer = fs.createWriteStream(audioFilePath);
    audioResponse.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // Send the audio to Whisper API to transcribe it
    const whisperResponse = await axios.post(
      process.env.TRANSCRIPTION_API_URL,
      {
        file: fs.createReadStream(audioFilePath),
      },
      {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      }
    );

    const transcriptionText = whisperResponse.data.captcha_text;

    if (!transcriptionText) {
      throw new Error("La transcripción está vacía.");
    }

    return {
      transcriptionText,
      audioFilePath,
    };
  } catch (error) {
    console.error("Error en transcribirAudio:", error.message);
    throw error;
  }
};

//Funcion para procesar url y validar INE. Función Principal
const validateINE = async (url) => {
  let browser;
  let browserDisconnected = false;

  // Ensure the temp folder exists
  if (!fs.existsSync(tempFolderPath)) {
    fs.mkdirSync(tempFolderPath);
  }

  try {
    browser = await puppeteer.launch({
      headless: headlessEnv,
      args: [
        "--ignore-certificate-errors",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-setuid-sandbox",
        // '--proxy-server=mx.smartproxy.com:20000',
      ],
    });

    const [page] = await browser.pages();

    await page.authenticate({
      username: "spkjg9luq1",
      password: "hWwNZms0mvxAn_757o",
    });

    // Configuración de la página
    await page.setViewport({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
    });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
    );

    // Evaluar en cada nueva página para emular un navegador real
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
      Object.defineProperty(navigator, "languages", {
        get: () => ["es-MX", "es"],
      });
    });

    // Navegar a la URL proporcionada
    console.log(`Navegando a la URL: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });

    // Interactuar con el reCAPTCHA
    console.log("Buscando iframe de reCAPTCHA...");
    const recaptchaFrameElement = await page.waitForSelector(
      'iframe[title="reCAPTCHA"]',
      { visible: true, timeout: 40000 }
    );
    const recaptchaFrame = await recaptchaFrameElement.contentFrame();

    if (!recaptchaFrame) {
      throw new Error(
        "No se pudo obtener el contexto del iframe de reCAPTCHA."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("Clic en el checkbox de reCAPTCHA.");
    const checkbox = await recaptchaFrame.waitForSelector(
      "#rc-anchor-container",
      { visible: true, timeout: 30000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await checkbox.click();

    let checkmarOk = await await recaptchaFrame
      .waitForSelector('span.recaptcha-checkbox-checked[aria-checked="true"]', {
        timeout: 3000,
        visible: true,
      })
      .then(() => true)
      .catch(() => false);

    console.log({ checkmarOk });

    let audioFilePath;
    let audioUrl;
    let transcriptionText;
    let verifyButton;
    let challengeFrame;

    if (!checkmarOk) {
      // obteniendo el iframe con el challenge
      console.log("obteniendo el iframe con el challenge");
      const challengeFrameElement = await page.waitForSelector(
        'iframe[src*="recaptcha/api2/bframe"]',
        { timeout: 30000 }
      );
      if (!challengeFrameElement) throw new Error("Challenge frame not found");

      console.log("Esperando a que aparezca el captcha");
      challengeFrame = await challengeFrameElement.contentFrame();
      const audioButton = await challengeFrame.waitForSelector(
        "#recaptcha-audio-button",
        { visible: true, timeout: 15000 }
      );
      console.log("Clic en el botón de audio del captcha.");
      // Función para hacer una pausa
      // Espera 2 segundos antes de hacer clic
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await audioButton.click();

      // Descargar el audio del CAPTCHA
      console.log("Descargando el audio del CAPTCHA...");
      const audioSourceElement = await challengeFrame.waitForSelector(
        "#audio-source"
      );
      const audioUrlHandle = await audioSourceElement.getProperty("src");
      audioUrl = await audioUrlHandle.jsonValue();

      // Configurar el evento de desconexión al inicio del script
      browser.on("disconnected", () => {
        console.log("El navegador se cerró abruptamente.");
        browserDisconnected = true;
      });
    }

    while (true && !checkmarOk) {
      console.log("bucle");
      try {
        // Verificar si el navegador ya se desconectó antes de cualquier operación asíncrona
        if (browserDisconnected) {
          console.log("El navegador se cerró, terminando el bucle.");
          break;
        }

        // Transcribir el audio usando la API de transcripción
        console.log("Transcribiendo el audio...");
        const result = await transcribirAudio(audioUrl);
        transcriptionText = result.transcriptionText;
        audioFilePath = result.audioFilePath;
        console.log("Transcripción del CAPTCHA:", transcriptionText);

        // Ingresar el texto transcrito en el campo de respuesta del audio
        const audioInput = await challengeFrame.waitForSelector(
          "#audio-response",
          { visible: true }
        );
        await audioInput.type(transcriptionText);

        // Intentar hacer clic en el botón de verificación
        verifyButton = await challengeFrame.waitForSelector(
          "#recaptcha-verify-button",
          { visible: true, timeout: 100000 }
        );

        // Verificar si el botón NO tiene la clase "rc-button-default-disabled"
        const isDisabled = await verifyButton.evaluate((button) =>
          button.classList.contains("rc-button-default-disabled")
        );
        console.log({ isDisabled });
        // await new Promise(resolve => setTimeout(resolve, 200000));

        if (!isDisabled) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await verifyButton.click();
          console.log("Clic en el botón de verificar CAPTCHA.");

          // Esperar un momento después de hacer clic para ver si se resolvió el CAPTCHA

          // Revisar si el CAPTCHA se resolvió correctamente (verificamos nuevamente el botón)
          const stillDisabled = await verifyButton.evaluate((button) =>
            button.classList.contains("rc-button-default-disabled")
          );
          console.log({ stillDisabled });
          if (!stillDisabled) {
            console.log("CAPTCHA resuelto correctamente.");
            break; // Sale del bucle si el CAPTCHA se resolvió
          }
        } else {
          console.log(
            "El botón de verificación está deshabilitado, reintentando..."
          );
        }
      } catch (error) {
        console.log("Error en el intento de verificación:");
        // Si hay un error, continuar con el siguiente intento
      }

      // Esperar un poco antes de intentar de nuevo
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Limpiar el archivo de audio descargado
    if (fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
      console.log("Archivo de audio eliminado.");
    }

    // clic en el botón de envío si el CAPTCHA fue resuelto correctamente
    const submitButton = await page.waitForSelector(
      'input[type="submit"][value="Consultar"]',
      { visible: true, timeout: 10000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await submitButton.click();
    console.log("Clic en el botón de envío del formulario.");

    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Esperar a que aparezca la imagen de vigencia
    console.log("Verificando si el INE está vigente");
    let vigente = await page
      .waitForSelector('img[src="images/si_vigente.png"]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    // Extraer fechas de vigencia si están disponibles, como tal da como resultado true fecha fin, false
    let fechaFin;
    if (vigente) {
      console.log("Esperando la etiqueta de fecha de validez...");

      // Espera a que aparezca al menos un elemento <b> en la página
      await page.waitForSelector("b", { visible: true, timeout: 10000 });

      // Selecciona todos los elementos <b> y filtra el que contiene el texto "Será válida hasta el"
      const elements = await page.$$("b");
      for (const element of elements) {
        const fullText = await page.evaluate((el) => el.textContent, element);

        if (fullText.includes("Será válida hasta el")) {
          let rawDate = fullText.replace("Será válida hasta el ", "").trim();
          console.log("Fecha de validez sin formato:", rawDate);

          // Format Day DD/MM/YYYY
          const dateParts = rawDate.split(" de ");
          if (dateParts.length === 3) {
            const day = dateParts[0].padStart(2, "0");
            const monthName = dateParts[1].toLowerCase();
            const year = dateParts[2];

            // Map months
            const months = {
              enero: "01",
              febrero: "02",
              marzo: "03",
              abril: "04",
              mayo: "05",
              junio: "06",
              julio: "07",
              agosto: "08",
              septiembre: "09",
              octubre: "10",
              noviembre: "11",
              diciembre: "12",
            };

            const month = months[monthName];

            if (month) {
              fechaFin = `${day}/${month}/${year}`;
              console.log("Fecha de validez formateada:", fechaFin);
            } else {
              console.error(`Nombre de mes desconocido: ${monthName}`);
            }
          } else {
            console.error(`Formato de fecha inesperado: ${rawDate}`);
          }
          break;
        }
      }

      if (!fechaFin) {
        console.log("No se encontró la etiqueta de fecha de validez.");
      }
    }

    dataResponse = {
      vigente,
      fechaFin,
    };
  } catch (error) {
    console.log("Ocurrió un error en el bloque try:", error.message);
    console.log("Cerrando el navegador...");
    await browser.close();
    console.log("Navegador cerrado.");
    return { error: true };
  }

  // Verificar si el navegador se cerró abruptamente y retornar el error si fue así
  if (browserDisconnected) {
    console.log("Retornando error por cierre abrupto del navegador Finaly.");
    return { error: true };
  }

  // Si el navegador aún está abierto y no se cerró abruptamente, lo cerramos manualmente
  if (browser && !browserDisconnected) {
    console.log("Cerrando el navegador...");
    await browser.close();
    console.log("Navegador cerrado.");
    return dataResponse;
  }
};

const ineManager = async (req = request, res = response) => {
  const ineUrl = req.headers["ineurl"];
  const data = await validateINE(ineUrl);
  console.log({ data });

  if (data?.error) {
    return res
      .status(500)
      .json({ error: "Error, vuelva a intentarlo." });
  }

  return res.status(200).json({ ...data });
};

module.exports = { validateINE, ineManager };
