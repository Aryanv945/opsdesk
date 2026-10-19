'use strict';
// Standalone worker process: `npm run worker` (start the API with RUN_WORKER=0).
const { openDb } = require('./db');
const { startWorker } = require('./worker');

const db = openDb();
const stop = startWorker(db);
console.log('OpsDesk worker running');
const shutdown = () => { stop(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
