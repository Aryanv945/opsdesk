'use strict';
/**
 * Outbox worker. Jobs are written in the same transaction as the change that
 * caused them, then processed here after the request has returned.
 *
 * Guarantees:
 *  - Claiming is atomic (conditional UPDATE), so two workers never run the same job concurrently.
 *  - A job is leased; if a worker crashes mid-job the lease expires and the job runs again.
 *  - Therefore delivery is at-least-once, and every handler must be idempotent.
 *    The notify handler is, via UNIQUE(user_id, activity_id) + INSERT OR IGNORE.
 *  - Failures retry with exponential backoff; after MAX_ATTEMPTS the job is
 *    marked `dead` and kept for inspection instead of silently disappearing.
 */
const { tx } = require('./db');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;
const backoffMs = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

const handlers = {
  notify(db, { activityId }, now) {
    const a = db.prepare(
      `SELECT a.*, u.name AS actor_name, w.title, w.assignee_id, w.reporter_id, t.key AS team_key
       FROM activity a JOIN users u ON u.id = a.actor_id
       JOIN work_items w ON w.id = a.item_id JOIN teams t ON t.id = a.team_id
       WHERE a.id = ?`
    ).get(activityId);
    if (!a) return; // nothing to do; treat as success
    const data = JSON.parse(a.data);

    // Recipients: current assignee, reporter, previous assignee (on reassignment),
    // and anyone who commented on the item. Never the actor themselves.
    // Jobs may run late, so "created" uses the assignee recorded in the event,
    // not whoever owns the item by the time the job runs.
    const recipients = a.kind === 'created' ? new Set([data.assigneeId]) : new Set([a.assignee_id, a.reporter_id]);
    if (a.kind === 'assigned' || a.kind === 'released') recipients.add(data.from);
    if (a.kind === 'commented' || a.kind === 'transitioned') {
      for (const r of db.prepare('SELECT DISTINCT author_id FROM comments WHERE item_id = ?').all(a.item_id)) recipients.add(r.author_id);
    }
    if (a.kind === 'transitioned' && data.to === 'awaiting_approval') {
      for (const r of db.prepare(`SELECT user_id FROM memberships WHERE team_id = ? AND role = 'lead'`).all(a.team_id)) recipients.add(r.user_id);
    }
    recipients.delete(a.actor_id);
    recipients.delete(null);
    recipients.delete(undefined);

    const message = describe(a, data);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO notifications (user_id, item_id, activity_id, message, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const userId of recipients) insert.run(userId, a.item_id, a.id, message, now);
  },
};

function describe(a, d) {
  const key = `${a.team_key}-${a.item_id}`;
  const who = a.actor_name;
  switch (a.kind) {
    case 'created': return `${who} created ${key}: ${a.title}`;
    case 'claimed': return `${who} took ${key}`;
    case 'assigned': return d.to ? `${who} reassigned ${key}` : `${who} unassigned ${key}`;
    case 'released': return `${who} released ${key}`;
    case 'transitioned':
      if (d.to === 'awaiting_approval') return `${who} requested approval on ${key}`;
      return `${who} moved ${key} to ${d.to.replace('_', ' ')}`;
    case 'commented': return `${who} commented on ${key}`;
    case 'updated': return `${who} updated ${Object.keys(d.changes || {}).join(', ')} on ${key}`;
    default: return `${who} changed ${key}`;
  }
}

/** Atomically leases the next ready job, or returns undefined. */
function claimNext(db, now) {
  return tx(db, () => {
    const job = db.prepare(
      `SELECT id FROM jobs
       WHERE (status = 'pending' AND run_after <= ?) OR (status = 'processing' AND locked_until < ?)
       ORDER BY run_after, id LIMIT 1`
    ).get(now, now);
    if (!job) return undefined;
    // The status/lease condition is repeated so a concurrent claimer cannot also win.
    const info = db.prepare(
      `UPDATE jobs SET status = 'processing', attempts = attempts + 1, locked_until = ?
       WHERE id = ? AND ((status = 'pending' AND run_after <= ?) OR (status = 'processing' AND locked_until < ?))`
    ).run(now + LEASE_MS, job.id, now, now);
    return info.changes ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) : undefined;
  });
}

function runJob(db, job, now, registry = handlers) {
  try {
    const handler = registry[job.kind];
    if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
    tx(db, () => {
      handler(db, JSON.parse(job.payload), now);
      db.prepare(`UPDATE jobs SET status = 'done', finished_at = ?, locked_until = NULL, last_error = NULL WHERE id = ?`).run(now, job.id);
    });
    return 'done';
  } catch (err) {
    const dead = job.attempts >= MAX_ATTEMPTS;
    db.prepare(
      `UPDATE jobs SET status = ?, run_after = ?, locked_until = NULL, last_error = ?, finished_at = ? WHERE id = ?`
    ).run(dead ? 'dead' : 'pending', now + backoffMs(job.attempts), String(err && err.message || err), dead ? now : null, job.id);
    return dead ? 'dead' : 'retry';
  }
}

/** Processes up to `max` ready jobs. Returns a summary (useful in tests). */
function drain(db, { now = () => Date.now(), max = 100, registry } = {}) {
  const summary = { done: 0, retry: 0, dead: 0 };
  for (let i = 0; i < max; i++) {
    const t = now();
    const job = claimNext(db, t);
    if (!job) break;
    summary[runJob(db, job, t, registry)]++;
  }
  return summary;
}

function startWorker(db, { intervalMs = 500, log = console } = {}) {
  let stopped = false;
  let timer;
  const tick = () => {
    if (stopped) return;
    try {
      const s = drain(db);
      if (s.dead) log.warn(`[worker] ${s.dead} job(s) moved to dead letter`);
      // Housekeeping: idempotency records only need to outlive client retries.
      db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(Date.now() - 24 * 3600e3);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    } catch (err) {
      log.error('[worker] tick failed', err);
    }
    timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { handlers, claimNext, runJob, drain, startWorker, MAX_ATTEMPTS, LEASE_MS, backoffMs };
