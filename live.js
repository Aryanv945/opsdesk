'use strict';
/**
 * Live updates over Server-Sent Events.
 *
 * Instead of publishing from request handlers (which would only reach clients
 * connected to the same process, and could announce changes that later roll
 * back), each server process tails the committed `activity` table and fans new
 * rows out to connected clients that are allowed to see that team. This works
 * unchanged with several app servers, and `Last-Event-ID` lets a reconnecting
 * browser resume without missing events.
 *
 * Events only carry identifiers and versions; clients refetch through the
 * normal authorized API, so SSE never becomes a second authorization path.
 */
const authz = require('./authz');
const { loadUser } = require('./auth');

function createLiveHub(db, { pollMs = 400 } = {}) {
  const clients = new Set();
  let lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity').get().id;
  const newer = db.prepare(
    `SELECT a.id, a.item_id, a.team_id, a.actor_id, a.kind, a.version, u.name AS actor_name
     FROM activity a JOIN users u ON u.id = a.actor_id WHERE a.id > ? ORDER BY a.id LIMIT 500`
  );

  function send(client, row) {
    if (!authz.hasRole(client.user, row.team_id, 'viewer')) return;
    client.res.write(`id: ${row.id}\nevent: activity\ndata: ${JSON.stringify({
      id: row.id, itemId: row.item_id, teamId: row.team_id, kind: row.kind, version: row.version,
      actor: { id: row.actor_id, name: row.actor_name },
    })}\n\n`);
  }

  function poll() {
    if (!clients.size) {
      lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity').get().id;
      return;
    }
    const rows = newer.all(lastId);
    for (const row of rows) {
      lastId = row.id;
      for (const c of clients) send(c, row);
    }
  }

  const timer = setInterval(poll, pollMs);
  const heartbeat = setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25_000);

  function handler(req, res) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const client = { user: req.user, res };
    // Replay anything missed since the last event the browser saw (bounded).
    const resumeFrom = Number(req.get('Last-Event-ID'));
    if (Number.isInteger(resumeFrom) && resumeFrom > 0 && resumeFrom < lastId) {
      for (const row of newer.all(resumeFrom).filter((r) => r.id <= lastId)) send(client, row);
    }
    clients.add(client);
    // Refresh this client's permissions periodically so membership changes take effect.
    const refresh = setInterval(() => { client.user = loadUser(db, req.user.id) || client.user; }, 60_000);
    req.on('close', () => { clients.delete(client); clearInterval(refresh); });
  }

  return { handler, poll, close: () => { clearInterval(timer); clearInterval(heartbeat); for (const c of clients) c.res.end(); } };
}

module.exports = { createLiveHub };
