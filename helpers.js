'use strict';
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PASSWORD = 'pw';
let pwHash;

/**
 * Small deterministic fixture:
 *   PAY: lead1, lead2 (leads), m1, m2 (members), viewer (viewer)
 *   SUP: outsider (member)
 *   admin: global admin, no memberships
 */
function setup(file = ':memory:') {
  const db = openDb(file);
  pwHash = pwHash || hashPassword(PASSWORD);
  const now = Date.now();
  const team = (key, name) => Number(db.prepare('INSERT INTO teams (key, name) VALUES (?, ?)').run(key, name).lastInsertRowid);
  const PAY = team('PAY', 'Payments');
  const SUP = team('SUP', 'Support');
  const users = {};
  const user = (name, isAdmin = 0) => {
    users[name] = Number(db.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`${name}@t.test`, name, pwHash, isAdmin, now).lastInsertRowid);
    return users[name];
  };
  const member = (u, t, role) => db.prepare('INSERT INTO memberships (user_id, team_id, role) VALUES (?, ?, ?)').run(u, t, role);
  member(user('lead1'), PAY, 'lead');
  member(user('lead2'), PAY, 'lead');
  member(user('m1'), PAY, 'member');
  member(user('m2'), PAY, 'member');
  member(user('viewer'), PAY, 'viewer');
  member(user('outsider'), SUP, 'member');
  user('admin', 1);

  const app = createApp(db, { log: { error() {}, warn() {} } });
  const agents = {};
  async function as(name) {
    if (!agents[name]) {
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').send({ email: `${name}@t.test`, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed for ${name}: ${res.status}`);
      agents[name] = agent;
    }
    return agents[name];
  }

  async function createItem(name = 'm1', overrides = {}) {
    const res = await (await as(name)).post('/api/items').send({
      teamId: PAY, title: 'Customer refund missing', type: 'task', priority: 2, ...overrides,
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.item;
  }

  return { db, app, as, createItem, teams: { PAY, SUP }, users };
}

module.exports = { setup, PASSWORD };
