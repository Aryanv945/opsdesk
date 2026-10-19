'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const worker = require('../src/worker');

const notes = (db, userId) => db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(userId);

test('changes notify the people involved, never the actor', async () => {
  const { as, createItem, db, users } = setup();
  const item = await createItem('m1'); // reporter m1
  await (await as('m2')).post(`/api/items/${item.id}/claim`).send({});
  worker.drain(db);
  const forReporter = notes(db, users.m1);
  assert.equal(forReporter.length, 1);
  assert.match(forReporter[0].message, /m2 took PAY-/);
  assert.equal(notes(db, users.m2).length, 0, 'actor is not notified about their own action');
});

test('requesting approval notifies the team leads', async () => {
  const { as, createItem, db, users } = setup();
  const item = await createItem('m1', { type: 'payment' });
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({});
  await m1.post(`/api/items/${item.id}/transition`).send({ to: 'awaiting_approval', expectedVersion: 2 });
  worker.drain(db);
  assert.ok(notes(db, users.lead1).some((n) => /requested approval/.test(n.message)));
  assert.ok(notes(db, users.lead2).some((n) => /requested approval/.test(n.message)));
});

test('a job that runs twice does not double-notify (at-least-once + idempotent handler)', async () => {
  const { as, createItem, db, users } = setup();
  const item = await createItem('m1');
  await (await as('m2')).post(`/api/items/${item.id}/comments`).send({ body: 'ping' });
  worker.drain(db);
  const before = notes(db, users.m1).length;
  // Simulate redelivery: put every finished job back in the queue and run again.
  db.prepare("UPDATE jobs SET status = 'pending', run_after = 0").run();
  const again = worker.drain(db);
  assert.ok(again.done > 0, 'jobs really did run a second time');
  assert.equal(notes(db, users.m1).length, before);
});

test('a worker that dies mid-job does not lose it: the lease expires and the job is retried', async () => {
  const { createItem, db } = setup();
  await createItem('m1');
  let t = Date.now();
  const leased = worker.claimNext(db, t); // worker A takes the job... and crashes
  assert.ok(leased);
  assert.equal(worker.claimNext(db, t + 1000), undefined, 'nobody else can take a leased job');
  t += worker.LEASE_MS + 1;
  const summary = worker.drain(db, { now: () => t }); // worker B, after the lease
  assert.equal(summary.done, 1);
  assert.equal(db.prepare('SELECT status, attempts FROM jobs WHERE id = ?').get(leased.id).status, 'done');
});

test('failing jobs back off, then land in a dead-letter state instead of vanishing', async () => {
  const { createItem, db } = setup();
  await createItem('m1');
  let calls = 0;
  const registry = { notify() { calls++; throw new Error('mail server down'); } };
  let t = Date.now();
  const first = worker.drain(db, { now: () => t, registry });
  assert.deepEqual(first, { done: 0, retry: 1, dead: 0 });
  // Not retried immediately.
  assert.deepEqual(worker.drain(db, { now: () => t, registry }), { done: 0, retry: 0, dead: 0 });

  for (let i = 0; i < worker.MAX_ATTEMPTS; i++) { t += 61_000; worker.drain(db, { now: () => t, registry }); }
  const job = db.prepare('SELECT * FROM jobs').get();
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, worker.MAX_ATTEMPTS);
  assert.equal(job.last_error, 'mail server down');
  assert.equal(calls, worker.MAX_ATTEMPTS);
});

test('a failed job rolls back its partial work', async () => {
  const { as, createItem, db, users } = setup();
  const item = await createItem('m1');
  await (await as('m2')).post(`/api/items/${item.id}/claim`).send({});
  const registry = {
    notify(dbx, payload, now) {
      worker.handlers.notify(dbx, payload, now); // writes notifications...
      throw new Error('crash after writing'); // ...then fails
    },
  };
  worker.drain(db, { registry });
  assert.equal(notes(db, users.m1).length, 0, 'no half-applied side effects');
});
