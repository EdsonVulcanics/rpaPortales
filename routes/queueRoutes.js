const express = require("express");
const router = express.Router();
const { handleAddToQueue } = require("../controllers/queueController"); // Import the controller logic
const { getCurpData, getCurpPng } = require("../services/curpService"); // Import the controller logic
const { getIneData } = require("../services/ineService"); // Import the controller logic
const { ineManager } = require("../services/ineValidation");
// Route to handle incoming POST requests and add tasks to the queue
router.post("/", handleAddToQueue);

router.get("/curp", getCurpData);
router.get("/curpPng", getCurpPng);

router.get("/ine", getIneData);

router.get("/ineValid", ineManager);

module.exports = router;

