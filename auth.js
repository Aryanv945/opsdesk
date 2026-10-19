'use strict';
const crypto = require('crypto');
const { unauthenticated } = require('./errors');

const SESSION_COOKIE = 'opsdesk_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now + SESSION_TTL_MS);
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

/** Loads the user and their team memberships. Permissions are re-read on every request, never cached in the session. */
function loadUser(db, userId) {
  const u = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const rows = db.prepare(
    `SELECT m.team_id, m.role, t.key, t.name FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name`
  ).all(userId);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: !!u.is_admin,
    roles: new Map(rows.map((r) => [r.team_id, r.role])),
    memberships: rows.map((r) => ({ teamId: r.team_id, teamKey: r.key, teamName: r.name, role: r.role })),
  };
}

function requireAuth(db) {
  const stmt = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?');
  return (req, _res, next) => {
    const token = readToken(req);
    const row = token && stmt.get(sha256(token), Date.now());
    const user = row && loadUser(db, row.user_id);
    if (!user) return next(unauthenticated());
    req.user = user;
    req.sessionToken = token;
    next();
  };
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_MS, hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, loadUser, readToken, sha256,
};
