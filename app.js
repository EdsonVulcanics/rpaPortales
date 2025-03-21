const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

const { initializeQueue } = require('./services/queueService');
const queueRoutes = require('./routes/queueRoutes');

const app = express();
const port = process.env.PORT || 3691;

// Middleware
app.use(cors());  // Add this line to enable CORS for all requests
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize the queue
initializeQueue()

// Routes
app.use('/', queueRoutes);

// Error handler
app.use(errorHandler);

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
