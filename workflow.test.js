'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

async function move(agent, id, to, note) {
  const { body } = await agent.get(`/api/items/${id}`);
  return agent.post(`/api/items/${id}/transition`).send({ to, note, expectedVersion: body.item.version });
}

test('payment items require approval and cannot be resolved directly', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1', { type: 'payment' });
  assert.equal(item.requiresApproval, true, 'payments default to requiring approval');
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({});
  const res = await move(m1, item.id, 'resolved');
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'APPROVAL_REQUIRED');
});

test('approval enforces separation of duties', async () => {
  const { as, createItem, users } = setup();
  const item = await createItem('lead1', { type: 'payment', assigneeId: null });
  const lead1 = await as('lead1');
  await lead1.post(`/api/items/${item.id}/claim`).send({});
  assert.equal((await move(lead1, item.id, 'awaiting_approval')).status, 200);

  // The assignee, even though a lead, may not approve their own work.
  const self = await move(lead1, item.id, 'resolved');
  assert.equal(self.status, 403);

  // A plain member may not approve at all.
  const member = await move(await as('m2'), item.id, 'resolved');
  assert.equal(member.status, 403);

  // A different lead can.
  const ok = await move(await as('lead2'), item.id, 'resolved');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.status, 'resolved');
  assert.equal(ok.body.item.approvedBy.id, users.lead2);
});

test('rejecting an approval requires a note and clears the approval', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1', { type: 'compliance' });
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({});
  await move(m1, item.id, 'awaiting_approval');
  const lead = await as('lead1');
  const noNote = await move(lead, item.id, 'in_progress');
  assert.equal(noNote.body.error.code, 'NOTE_REQUIRED');
  const rejected = await move(lead, item.id, 'in_progress', 'Need the bank reference first');
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.item.status, 'in_progress');
  assert.equal(rejected.body.item.approvedBy, null);
});

test('illegal jumps are rejected regardless of role', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  const res = await move(await as('admin'), item.id, 'closed');
  assert.equal(res.status, 422, 'open -> closed is a cancel and needs a note');
  const res2 = await move(await as('admin'), item.id, 'resolved');
  assert.equal(res2.status, 422);
  assert.equal(res2.body.error.code, 'INVALID_TRANSITION');
});

test('only the assignee or a lead can progress assigned work', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  await (await as('m1')).post(`/api/items/${item.id}/claim`).send({});
  const other = await move(await as('m2'), item.id, 'blocked', 'waiting on vendor');
  assert.equal(other.status, 403);
  const lead = await move(await as('lead1'), item.id, 'blocked', 'waiting on vendor');
  assert.equal(lead.status, 200);
});

test('starting work requires an owner; marking blocked requires a reason', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  const lead = await as('lead1');
  const start = await move(lead, item.id, 'in_progress');
  assert.equal(start.body.error.code, 'ASSIGNEE_REQUIRED');
  await (await as('m1')).post(`/api/items/${item.id}/claim`).send({});
  const blocked = await move(await as('m1'), item.id, 'blocked');
  assert.equal(blocked.body.error.code, 'NOTE_REQUIRED');
});

test('closed items are read-only until a lead reopens them', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({});
  await move(m1, item.id, 'resolved');
  assert.equal((await move(m1, item.id, 'closed')).status, 200, 'reporter may close');
  const { body } = await m1.get(`/api/items/${item.id}`);
  const edit = await m1.patch(`/api/items/${item.id}`).send({ expectedVersion: body.item.version, changes: { title: 'Changed after close' } });
  assert.equal(edit.status, 403);
  assert.equal((await move(m1, item.id, 'open', 'not fixed')).status, 403);
  const reopened = await move(await as('lead1'), item.id, 'open', 'Customer reports it again');
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.item.assignee, null);
});

test('every change is recorded in the item history', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1');
  const m1 = await as('m1');
  await m1.post(`/api/items/${item.id}/claim`).send({});
  await m1.patch(`/api/items/${item.id}`).send({ expectedVersion: 2, changes: { priority: 1 } });
  await m1.post(`/api/items/${item.id}/comments`).send({ body: 'Root cause found' });
  await move(m1, item.id, 'resolved', 'patched');
  const { body } = await m1.get(`/api/items/${item.id}/activity`);
  assert.deepEqual(body.entries.map((e) => e.kind), ['transitioned', 'commented', 'updated', 'claimed', 'created']);
  assert.equal(body.entries[1].data.body, 'Root cause found');
  assert.deepEqual(body.entries[2].data.changes.priority, { from: 2, to: 1 });
});
