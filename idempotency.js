'use strict';
/**
 * Idempotent mutations.
 *
 * Clients send an `Idempotency-Key` header (a UUID generated once per user
 * intent and reused on every retry). The stored response and the mutation are
 * committed in the *same* transaction, so there is no window in which the
 * change exists but the key does not (or vice versa):
 *
 *   - first request      → run the mutation, store {status, body}, return it
 *   - retry, same body   → return the stored response, run nothing (header Idempotent-Replayed: true)
 *   - same key, new body → 422; the client has a bug and we refuse to guess
 *
 * Failed requests are not stored, so a retry after an error re-evaluates.
 */
const crypto = require('crypto');
const { tx } = require('./db');
const { unprocessable, badRequest } = require('./errors');

function runIdempotent(db, req, res, mutate) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    const { status, body } = tx(db, mutate);
    return res.status(status).json(body);
  }
  if (key.length > 200) throw badRequest('Idempotency-Key is too long');
  const requestHash = crypto.createHash('sha256')
    .update(`${req.method} ${req.originalUrl.split('?')[0]} ${JSON.stringify(req.body ?? {})}`).digest('hex');

  const result = tx(db, () => {
    const prior = db.prepare('SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = ? AND key = ?')
      .get(req.user.id, key);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      return { status: prior.status_code, body: JSON.parse(prior.response), replayed: true };
    }
    const { status, body } = mutate();
    db.prepare('INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, key, requestHash, status, JSON.stringify(body), Date.now());
    return { status, body, replayed: false };
  });
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

module.exports = { runIdempotent };
