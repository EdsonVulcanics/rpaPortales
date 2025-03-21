require('dotenv').config();
let Queue;

const concurrency = process.env.QUEUE || 1; 

// Initialize the queue with concurrency limit
const initializeQueue = async () => {
    const pQueue = await import('p-queue');
    Queue = pQueue.default || pQueue.Queue;
    global.queue = new Queue({ concurrency: parseInt(concurrency, 10) });
};

// Add a task to the queue
const addToQueue = (task) => {
    if (!global.queue) {
        throw new Error('Queue has not been initialized.');
    }
    return global.queue.add(task);  // Adds the task to the queue to be executed
};

module.exports = { initializeQueue, addToQueue };
