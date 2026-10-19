'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup } = require('./helpers');

test('two people claiming the same item at once: exactly one wins', async () => {
  const { as, createItem, db, users } = setup();
  const item = await createItem('lead1');
  const [a, b] = await Promise.all([
    (await as('m1')).post(`/api/items/${item.id}/claim`).send({}),
    (await as('m2')).post(`/api/items/${item.id}/claim`).send({}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error.code, 'ALREADY_CLAIMED');
  assert.ok(loser.body.error.details.assignee.name, 'loser is told who won');

  const row = db.prepare('SELECT assignee_id, status FROM work_items WHERE id = ?').get(item.id);
  assert.ok([users.m1, users.m2].includes(row.assignee_id));
  assert.equal(row.status, 'in_progress');
  const claims = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE item_id = ? AND kind = 'claimed'").get(item.id).n;
  assert.equal(claims, 1, 'only one claim recorded in history');
});

test('re-claiming an item you already own is a harmless no-op', async () => {
  const { as, createItem, db } = setup();
  const item = await createItem('lead1');
  const m1 = await as('m1');
  const first = await m1.post(`/api/items/${item.id}/claim`).send({});
  const again = await m1.post(`/api/items/${item.id}/claim`).send({});
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyOwned, true);
  assert.equal(again.body.item.version, first.body.item.version, 'no version bump on repeat');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE item_id = ? AND kind = 'claimed'").get(item.id).n, 1);
});

test('editing from a stale version is rejected with what changed, and nothing is overwritten', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  const m1 = await as('m1');
  const m2 = await as('m2');

  // Both load version 1. m1 saves first.
  const ok = await m1.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { priority: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.version, 2);

  // m2 still thinks it is version 1.
  const stale = await m2.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { title: 'Overwritten title' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.error.details.currentVersion, 2);
  assert.deepEqual(stale.body.error.details.changes[0].data.changes.priority, { from: 2, to: 1 });
  assert.equal(stale.body.error.details.current.priority, 1);

  const now = await m1.get(`/api/items/${item.id}`);
  assert.equal(now.body.item.title, item.title, 'stale write did not land');
  assert.equal(now.body.item.priority, 1, 'first write preserved');
});

test('a burst of updates against the same version: exactly one succeeds', async () => {
  const { as, createItem, db } = setup();
  const item = await createItem('m1');
  const agents = await Promise.all(['m1', 'm2', 'lead1', 'lead2'].map(as));
  const results = await Promise.all(agents.flatMap((agent, i) => [1, 2, 3].map((p) =>
    agent.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { title: `Edit ${i}-${p}` } }))));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, results.length - 1);
  assert.equal(db.prepare('SELECT version FROM work_items WHERE id = ?').get(item.id).version, 2);
});

test('workflow transitions also require the current version', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1', { assigneeId: null });
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({}); // -> v2, in_progress
  const res = await m1.post(`/api/items/${item.id}/transition`).send({ to: 'resolved', expectedVersion: 1 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VERSION_CONFLICT');
});

test('comments never cause edit conflicts', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  await (await as('m2')).post(`/api/items/${item.id}/comments`).send({ body: 'Looking into it' });
  const edit = await (await as('m1')).patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { priority: 3 } });
  assert.equal(edit.status, 200);
});

// The in-process tests above prove the logic; this one proves it under real
// parallelism: separate OS processes racing on the same database file.
test('claim race across 8 separate processes on one database file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsdesk-race-'));
  const file = path.join(dir, 'race.db');
  const { createItem, db } = setup(file);
  const item = await createItem('lead1');
  const contenders = db.prepare("SELECT id FROM users WHERE name NOT IN ('viewer','outsider','admin')").all().map((r) => r.id);
  db.close();

  const script = `
    const { openDb, tx } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});
    const { loadUser } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'auth'))});
    const items = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'items'))});
    const db = openDb(process.argv[1]);
    const user = loadUser(db, Number(process.argv[2]));
    const go = Number(process.argv[3]);
    while (Date.now() < go) {} // line everyone up on the same millisecond
    try { const r = tx(db, () => items.claimItem(db, user, Number(process.argv[4]))); console.log(r.alreadyOwned ? 'OWNED' : 'WON'); }
    catch (e) { console.log(e.code || e.message); }`;
  const start = Date.now() + 600;
  const runs = [...contenders, ...contenders].map((uid) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script, file, String(uid), String(start), String(item.id)]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => resolve({ uid, out: out.trim() }));
  }));
  const results = await Promise.all(runs);
  const winners = results.filter((r) => r.out === 'WON');
  assert.equal(winners.length, 1, JSON.stringify(results));
  // Everyone else is told it is taken; only the winner's own duplicate may see "already yours".
  for (const r of results.filter((x) => x.out !== 'WON')) {
    if (r.out === 'OWNED') assert.equal(r.uid, winners[0].uid);
    else assert.equal(r.out, 'ALREADY_CLAIMED');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
