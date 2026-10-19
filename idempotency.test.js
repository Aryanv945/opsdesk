'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;

test('retrying a create with the same Idempotency-Key does not create a duplicate', async () => {
  const { as, db, teams } = setup();
  const m1 = await as('m1');
  const body = { teamId: teams.PAY, title: 'Payment stuck for order 991', type: 'payment', priority: 1 };
  const first = await m1.post('/api/items').set('Idempotency-Key', 'k-1').send(body);
  const retry = await m1.post('/api/items').set('Idempotency-Key', 'k-1').send(body);

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.deepEqual(retry.body, first.body, 'the original response is replayed');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM work_items'), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity WHERE kind = 'created'"), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs'), 1, 'side effects are not re-enqueued');
});

test('a double-submitted comment is stored once', async () => {
  const { as, createItem, db } = setup();
  const item = await createItem();
  const m2 = await as('m2');
  const send = () => m2.post(`/api/items/${item.id}/comments`).set('Idempotency-Key', 'c-77').send({ body: 'On it' });
  const results = await Promise.all([send(), send(), send()]);
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM comments WHERE item_id = ?', item.id), 1);
});

test('reusing a key for a different request is refused', async () => {
  const { as, teams } = setup();
  const m1 = await as('m1');
  await m1.post('/api/items').set('Idempotency-Key', 'k-2').send({ teamId: teams.PAY, title: 'First thing', type: 'task', priority: 3 });
  const res = await m1.post('/api/items').set('Idempotency-Key', 'k-2').send({ teamId: teams.PAY, title: 'Something else', type: 'task', priority: 3 });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('keys are scoped per user', async () => {
  const { as, db, teams } = setup();
  const body = { teamId: teams.PAY, title: 'Same key, different people', type: 'task', priority: 3 };
  await (await as('m1')).post('/api/items').set('Idempotency-Key', 'shared').send(body);
  const other = await (await as('m2')).post('/api/items').set('Idempotency-Key', 'shared').send(body);
  assert.equal(other.status, 201);
  assert.notEqual(other.headers['idempotent-replayed'], 'true');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM work_items'), 2);
});

test('failed requests are not remembered, so a retry is evaluated again', async () => {
  const { as, createItem, db } = setup();
  const item = await createItem();
  const m1 = await as('m1');
  // Fails: m2 holds a stale version.
  await m1.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { priority: 1 } });
  const m2 = await as('m2');
  const failed = await m2.patch(`/api/items/${item.id}`).set('Idempotency-Key', 'p-1').send({ expectedVersion: 1, changes: { priority: 4 } });
  assert.equal(failed.status, 409);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM idempotency_keys'), 0);
});

test('the mutation and its idempotency record commit together (rollback leaves neither)', async () => {
  const { as, createItem, db } = setup();
  const item = await createItem();
  const viewer = await as('viewer');
  const res = await viewer.post(`/api/items/${item.id}/claim`).set('Idempotency-Key', 'v-1').send({});
  assert.equal(res.status, 403);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM idempotency_keys'), 0);
  assert.equal(db.prepare('SELECT assignee_id FROM work_items WHERE id = ?').get(item.id).assignee_id, null);
});
