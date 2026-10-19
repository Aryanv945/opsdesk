'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');

test('unauthenticated requests are rejected', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/items');
  assert.equal(res.status, 401);
});

test('users outside the team get 404 for its items, not 403', async () => {
  const { as, createItem, teams } = setup();
  const item = await createItem();
  const outsider = await as('outsider');
  assert.equal((await outsider.get(`/api/items/${item.id}`)).status, 404);
  assert.equal((await outsider.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { priority: 1 } })).status, 404);
  assert.equal((await outsider.post(`/api/items/${item.id}/claim`).send({})).status, 404);
  assert.equal((await outsider.post(`/api/items/${item.id}/comments`).send({ body: 'hi' })).status, 404);
  assert.equal((await outsider.get(`/api/items/${item.id}/activity`)).status, 404);
  assert.equal((await outsider.get(`/api/teams/${teams.PAY}/members`)).status, 404);
  const create = await outsider.post('/api/items').send({ teamId: teams.PAY, title: 'Sneaky item', type: 'task', priority: 3 });
  assert.equal(create.status, 404);
});

test('list, search and dashboard never include items from other teams', async () => {
  const { as, createItem } = setup();
  await createItem('m1', { title: 'Zebracorn ledger mismatch' });
  const outsider = await as('outsider');
  const list = await outsider.get('/api/items').query({ q: 'zebracorn' });
  assert.equal(list.body.total, 0);
  const dash = await outsider.get('/api/dashboard');
  assert.equal(dash.body.teams.length, 0);
  const member = await as('m2');
  assert.equal((await member.get('/api/items').query({ q: 'zebracorn' })).body.total, 1);
});

test('viewers can read and comment but not change work', async () => {
  const { as, createItem } = setup();
  const item = await createItem();
  const viewer = await as('viewer');
  assert.equal((await viewer.get(`/api/items/${item.id}`)).status, 200);
  assert.equal((await viewer.post(`/api/items/${item.id}/comments`).send({ body: 'Any update?' })).status, 201);
  assert.equal((await viewer.post(`/api/items/${item.id}/claim`).send({})).status, 403);
  assert.equal((await viewer.patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { priority: 1 } })).status, 403);
  const { body } = await viewer.get(`/api/items/${item.id}`);
  assert.equal(body.item.permissions.edit, false, 'UI hint matches server rule');
  assert.equal(body.item.permissions.claim, false);
});

test('only leads assign work to others, and only to people who can work in that team', async () => {
  const { as, createItem, users } = setup();
  const item = await createItem();
  const asMember = await (await as('m1')).post(`/api/items/${item.id}/assign`).send({ assigneeId: users.m2, expectedVersion: 1 });
  assert.equal(asMember.status, 403);
  const lead = await as('lead1');
  const toViewer = await lead.post(`/api/items/${item.id}/assign`).send({ assigneeId: users.viewer, expectedVersion: 1 });
  assert.equal(toViewer.body.error.code, 'INVALID_ASSIGNEE');
  const toOutsider = await lead.post(`/api/items/${item.id}/assign`).send({ assigneeId: users.outsider, expectedVersion: 1 });
  assert.equal(toOutsider.body.error.code, 'INVALID_ASSIGNEE');
  const ok = await lead.post(`/api/items/${item.id}/assign`).send({ assigneeId: users.m2, expectedVersion: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.assignee.id, users.m2);
  assert.equal(ok.body.item.status, 'in_progress');
});

test('members cannot sneak an assignment in at creation time', async () => {
  const { as, teams, users } = setup();
  const res = await (await as('m1')).post('/api/items').send({ teamId: teams.PAY, title: 'Do this for me', type: 'task', priority: 3, assigneeId: users.m2 });
  assert.equal(res.status, 403);
});

test('only leads can change whether an item needs approval', async () => {
  const { as, createItem } = setup();
  const item = await createItem('m1', { type: 'payment' });
  const res = await (await as('m1')).patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { requiresApproval: false } });
  assert.equal(res.status, 403);
  const ok = await (await as('lead1')).patch(`/api/items/${item.id}`).send({ expectedVersion: 1, changes: { requiresApproval: false } });
  assert.equal(ok.status, 200);
});

test('admins can see and act on every team', async () => {
  const { as, createItem } = setup();
  const item = await createItem();
  const admin = await as('admin');
  assert.equal((await admin.get(`/api/items/${item.id}`)).status, 200);
  assert.equal((await admin.get('/api/items')).body.total, 1);
});

test('membership changes take effect on the next request', async () => {
  const { as, createItem, db, users, teams } = setup();
  const item = await createItem();
  const m2 = await as('m2');
  assert.equal((await m2.get(`/api/items/${item.id}`)).status, 200);
  db.prepare('DELETE FROM memberships WHERE user_id = ? AND team_id = ?').run(users.m2, teams.PAY);
  assert.equal((await m2.get(`/api/items/${item.id}`)).status, 404);
});
