const fs = require('fs');
const { processCurp, storeCurpData } = require('../services/curpService');
const { processSat } = require('../services/processSat');
const { processCfdi } = require('../services/cfdiService');
const { processIne, extractCicAndId,storeIneRequest } = require('../services/ineService');

let curpQueue, cfdiQueue, ineQueue;

const initializeQueues = async () => {
    const PQueue = (await import('p-queue')).default;
    curpQueue = new PQueue({ concurrency: 1 });
    ineQueue = new PQueue({ concurrency: 1 });
    cfdiQueue = new PQueue({ concurrency: 1 });
};

// Call the async function to initialize queues
initializeQueues().catch(err => {
    console.error('Error initializing queues:', err);
});

const handleAddToQueue = async (req, res) => {
    try {
        let { operation, curp, url } = req.body;

        // If curp or url is null/undefined, try finding them in the headers
        curp = curp || req.headers['curp'];
        operation = operation || req.headers['operation'];
        url = url || req.headers['url'];

        // Handle the "curp" operation
        if (operation === 'curp') {
            if (!curp || curp.length !== 18) {
                return res.status(400).json({ message: 'CURP must be 18 characters long' });
            }

            // Save the initial request in the database with status "processing"
            await storeCurpData(curp, { status: 'processing' });

            // Add the CURP processing to the queue
            curpQueue.add(() => processCurp(curp)
                .catch((err) => {
                    console.error(`Error processing CURP ${curp}:`, err);
                    storeCurpData(curp, { status: 'failed' });
                })
            );

            // Return the CURP as the tracking ID
            return res.status(202).json({
                message: 'CURP request received. Use the CURP to check status.',
                id: curp
            });
        }

        // Handle the "SAT" operation (no queue needed for SAT)
        if (operation === 'sat') {
            if (!url) {
                return res.status(400).json({ message: 'URL is required for SAT operation' });
            }

            // Process SAT data directly
            const satData = await processSat(url);

            if (satData.status === 'success') {
                return res.status(200).json(satData.data);
            } else {
                return res.status(400).json({ message: satData.message });
            }
        }

        // Handle the "cfdi" operation
        if (operation === 'cfdi') {
            if (!url) {
                return res.status(400).json({ message: 'URL is required for CFDI operation' });
            }

            const urlParams = new URLSearchParams(url.split('?')[1]);

            const requiredParams = ['id', 're', 'rr', 'tt', 'fe'];
            for (const param of requiredParams) {
                const value = urlParams.get(param);
                if (!value) {
                    return res.status(200).json({ message: `Missing or empty required parameter: ${param}` });
                }
            }

            // Call the service to fetch and process the CFDI information
            const cfdiData = await processCfdi(url);

            if (cfdiData.status === 'success') {
                return res.status(200).json(cfdiData.data);
                
            } else {
                return res.status(400).json({ message: cfdiData.message });
            }
        }

        // Handle the "INE" operation
        if (operation === 'ine') {
            if (!url) {
                return res.status(400).json({ message: 'URL is required for INE operation' });
            }

            const { cic, idCiudadano } = extractCicAndId(url);
            const id = cic + idCiudadano;
            await storeIneRequest(id, 'processing');

            // Add INE processing to the queue
            ineQueue.add(() => processIne(url)
                .catch(err => {
                    console.error(`Error processing INE ${id}:`, err);
                    storeIneRequest(id, 'failed');
                    res.status(500).json({ message: 'Error processing INE' });
                })
            );

            // Return the ID for tracking
            return res.status(202).json({
                message: 'INE request received. Use this ID to check the status later.',
                id
            });
        }

        return res.status(400).json({ message: 'Invalid operation: ' + operation });
    } catch (error) {
        console.error('Error processing request:', error.message);
        return res.status(500).send(`Error processing request: ${error.message}`);
    }
};

module.exports = { handleAddToQueue };
