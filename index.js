'use strict';
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createLiveHub } = require('./live');
const { startWorker } = require('./worker');

const db = openDb();
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  console.log('Empty database — seeding demo data (set SEED_ITEMS to change volume)...');
  require('./seed').seed(db, { items: Number(process.env.SEED_ITEMS || 20000) });
}

const live = createLiveHub(db);
const app = createApp(db, { live });
// The worker runs in-process for simplicity; it can be moved to its own
// process (`npm run worker`) because it only coordinates through the database.
const stopWorker = process.env.RUN_WORKER === '0' ? () => {} : startWorker(db);

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`OpsDesk API listening on http://localhost:${port}`));

function shutdown() {
  stopWorker();
  live.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
