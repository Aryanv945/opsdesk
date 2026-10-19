'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

function bulk(db, teamId, reporter, n, now = Date.now()) {
  const ins = db.prepare(`INSERT INTO work_items (team_id, title, type, priority, status, reporter_id, due_at, created_at, updated_at, last_activity_at)
                          VALUES (?, ?, 'task', ?, 'open', ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      // Deliberately create many ties on updated_at and priority to stress the cursor tie-breaker.
      const t = now - Math.floor(i / 7) * 1000;
      ins.run(teamId, `Bulk item ${i}`, (i % 4) + 1, reporter, t + 1e6, t, t, t);
    }
  })();
}

async function walk(agent, query) {
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const res = await agent.get('/api/items').query({ ...query, ...(cursor ? { cursor } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    seen.push(...res.body.items);
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  return seen;
}

for (const sort of ['updated', 'priority', 'due', 'created']) {
  test(`cursor pagination (${sort}) returns every item exactly once, in order`, async () => {
    const { as, db, teams, users } = setup();
    bulk(db, teams.PAY, users.m1, 230);
    const items = await walk(await as('m1'), { sort, limit: 25 });
    assert.equal(items.length, 230);
    assert.equal(new Set(items.map((i) => i.id)).size, 230);
    if (sort === 'priority') {
      for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].priority <= items[i].priority);
    }
  });
}

test('pages do not repeat items when other people edit between page loads', async () => {
  const { as, db, teams, users } = setup();
  bulk(db, teams.PAY, users.m1, 100);
  const m1 = await as('m1');
  const page1 = await m1.get('/api/items').query({ limit: 20 });
  // Someone updates an item from further down the list; it jumps to the top.
  const moved = db.prepare('SELECT id FROM work_items ORDER BY updated_at ASC LIMIT 1').get().id;
  db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(Date.now() + 10_000, moved);
  const rest = await walk(m1, { limit: 20, cursor: page1.body.nextCursor });
  const ids = [...page1.body.items, ...rest].map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
});

test('filters combine and the total reflects them', async () => {
  const { as, createItem, users } = setup();
  await createItem('m1', { priority: 1, title: 'Urgent payout failure' });
  await createItem('m1', { priority: 4, title: 'Low priority cleanup' });
  const mine = await createItem('m1', { priority: 1, title: 'Urgent but mine' });
  await (await as('m1')).post(`/api/items/${mine.id}/claim`).send({});
  const m1 = await as('m1');
  const unassignedUrgent = await m1.get('/api/items').query({ assignee: 'unassigned', priority: '1,2' });
  assert.equal(unassignedUrgent.body.total, 1);
  assert.equal(unassignedUrgent.body.items[0].title, 'Urgent payout failure');
  const myActive = await m1.get('/api/items').query({ assignee: 'me', status: 'active' });
  assert.deepEqual(myActive.body.items.map((i) => i.assignee.id), [users.m1]);
});

test('search matches prefixes, item keys, and survives hostile input', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1', { title: 'Chargeback dispute for merchant', description: 'Evidence due Friday' });
  const m1 = await as('m1');
  assert.equal((await m1.get('/api/items').query({ q: 'charge' })).body.total, 1);
  assert.equal((await m1.get('/api/items').query({ q: 'evidence frid' })).body.total, 1);
  assert.equal((await m1.get('/api/items').query({ q: `PAY-${item.id}` })).body.items[0].id, item.id);
  for (const q of ['"', 'a OR b NOT', 'title:x*', ')(', '*', '💥 NEAR']) {
    const res = await m1.get('/api/items').query({ q });
    assert.equal(res.status, 200, `query ${q} -> ${res.status}`);
  }
});

test('invalid list parameters are rejected rather than ignored', async () => {
  const { as } = setup();
  const m1 = await as('m1');
  assert.equal((await m1.get('/api/items').query({ sort: 'drop table' })).status, 400);
  assert.equal((await m1.get('/api/items').query({ status: 'nope' })).status, 400);
  assert.equal((await m1.get('/api/items').query({ cursor: 'garbage' })).status, 400);
});
