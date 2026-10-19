'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Opens (and migrates) a database. `:memory:` is used by tests.
 * WAL lets readers proceed while a writer commits; busy_timeout makes a second
 * process (e.g. a separate worker) wait for the write lock instead of failing.
 */
function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'opsdesk.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

/**
 * Runs fn inside a write transaction. BEGIN IMMEDIATE takes the write lock up
 * front so a read-then-write sequence cannot interleave with another writer.
 */
function tx(db, fn) {
  return db.transaction(fn).immediate();
}

module.exports = { openDb, migrate, tx };
