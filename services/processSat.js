const axios = require('axios');
const cheerio = require('cheerio');

const processSat = async (url) => {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        // Helper function to parse rows into key-value pairs
        const parseTableByHeader = (headerText) => {
            const data = {};
            const table = $(`li:contains(${headerText})`).next('li').find('table');
            table.find('tr').each((index, element) => {
                const label = $(element).find('td').first().text().trim();
                const value = $(element).find('td').last().text().trim();
                if (label && value) {
                    data[label] = value;
                }
            });
            return data;
        };

        // Parse data from the three sections
        let identificationData = parseTableByHeader('Datos de Identificación');
        let locationData = parseTableByHeader('Datos de Ubicación');
        let fiscalData = parseTableByHeader('Características fiscales');

        // Cleanup function to remove unwanted data
        const cleanupData = (data) => {
            for (let key in data) {
                // If key or value contains JavaScript function calls or unusually long strings, delete it
                if (key.includes('function') || key.length > 150) {
                    delete data[key];
                }
            }
        };

        // Clean up the three sections
        cleanupData(identificationData);
        cleanupData(locationData);
        cleanupData(fiscalData);

        // Structure the cleaned data
        const satData = {
            Identificación: identificationData,
            Ubicación: locationData,
            fiscal: fiscalData,
        };
        // Create a new empty object to store the flattened data
        const flattenedSatData = {};

        // Merge all the nested objects into a single-level object
        Object.assign(flattenedSatData, satData.Identificación, satData.Ubicación, satData.fiscal);

        return { status: 'success', data: flattenedSatData };
    } catch (error) {
        console.error('Error fetching SAT data:', error.message);
        return { status: 'error', message: 'Failed to retrieve SAT data' };
    }
};

module.exports = { processSat };
