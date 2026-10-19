'use strict';
/**
 * Demo data. Creates named demo accounts (password: "password"), a few hundred
 * background users, and N work items with realistic history so the list,
 * search and dashboard can be judged at the scale described in the brief.
 *
 *   node src/seed.js --reset --items 20000
 */
const { hashPassword } = require('./auth');
const { SLA_MS, APPROVAL_DEFAULT_TYPES } = require('./workflow');

const TEAMS = [
  ['PAY', 'Payments'], ['SUP', 'Customer Support'], ['ENG', 'Platform Engineering'],
  ['SRE', 'Site Reliability'], ['CMP', 'Compliance'], ['OPS', 'Business Operations'],
];

// [email prefix, name, isAdmin, {TEAM: role}]
const DEMO = [
  ['alice', 'Alice Admin', 1, {}],
  ['ben', 'Ben Lead', 0, { PAY: 'lead', SUP: 'member' }],
  ['priya', 'Priya Lead', 0, { PAY: 'lead', CMP: 'lead' }],
  ['chen', 'Chen Member', 0, { PAY: 'member' }],
  ['dana', 'Dana Member', 0, { PAY: 'member', SRE: 'member' }],
  ['sam', 'Sam SRE Lead', 0, { SRE: 'lead', ENG: 'member' }],
  ['omar', 'Omar Support', 0, { SUP: 'member' }],
  ['vic', 'Vic Viewer', 0, { PAY: 'viewer', SUP: 'viewer', SRE: 'viewer' }],
];

const TEAM_TYPES = {
  PAY: ['payment', 'payment', 'customer_issue', 'task', 'compliance'],
  SUP: ['customer_issue', 'customer_issue', 'task', 'payment'],
  ENG: ['engineering', 'engineering', 'task', 'incident'],
  SRE: ['incident', 'incident', 'engineering', 'task'],
  CMP: ['compliance', 'compliance', 'task'],
  OPS: ['task', 'task', 'compliance', 'customer_issue'],
};

const TITLES = {
  payment: ['Refund not received for order {n}', 'Duplicate charge on invoice {n}', 'Payout to merchant {n} failed', 'Chargeback dispute #{n} needs evidence', 'Settlement mismatch for batch {n}', 'Investigate failed card payments from {region}'],
  customer_issue: ['Customer cannot reset password ({region})', 'Enterprise account {n} reports missing data', 'Order {n} stuck in processing', 'Customer requests data export', 'Login loop on mobile app for account {n}', 'Escalation: VIP customer {n} unhappy with response time'],
  engineering: ['Flaky test in checkout service', 'Upgrade database driver in billing-api', 'Memory leak in notification worker', 'Slow query on reports page', 'Add retries to webhook delivery', 'Deprecate legacy export endpoint'],
  incident: ['Elevated 5xx on payments API in {region}', 'Queue backlog growing on ingestion', 'Latency spike on search cluster', 'Certificate expiring on {region} edge', 'Disk usage 90% on db replica {n}', 'Partial outage: login in {region}'],
  compliance: ['GDPR deletion request #{n}', 'KYC review for merchant {n}', 'Quarterly access review for finance tools', 'Data retention audit: {region}', 'Sanctions screening hit for account {n}', 'SOC 2 evidence collection: change management'],
  task: ['Rotate on-call schedule for next month', 'Approve vendor contract renewal #{n}', 'Update runbook for {region} failover', 'Onboard new team member', 'Reconcile Q3 spreadsheet with ledger', 'Prepare weekly operations report'],
};
const REGIONS = ['EU-West', 'US-East', 'APAC', 'India', 'LATAM'];
const COMMENTS = ['Looking into this now.', 'Customer confirmed the issue persists.', 'Linked to the incident from yesterday.', 'Waiting on finance to confirm the amount.', 'Root cause identified, preparing fix.', 'Can someone from payments double-check this?', 'Escalated to the vendor.', 'Fix deployed, monitoring.'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function seed(db, { items = 20000, bulkUsers = 240, now = Date.now(), log = console.log } = {}) {
  const rand = rng(42);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pw = hashPassword('password'); // one hash reused for speed; every account's password is "password"
  const started = Date.now();

  db.transaction(() => {
    const insTeam = db.prepare('INSERT INTO teams (key, name) VALUES (?, ?)');
    const teamIds = {};
    for (const [key, name] of TEAMS) teamIds[key] = Number(insTeam.run(key, name).lastInsertRowid);

    const insUser = db.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)');
    const insMem = db.prepare('INSERT INTO memberships (user_id, team_id, role) VALUES (?, ?, ?)');
    const workers = Object.fromEntries(TEAMS.map(([k]) => [k, []])); // users who can be assigned, per team
    const leads = Object.fromEntries(TEAMS.map(([k]) => [k, []]));

    for (const [p, name, admin, roles] of DEMO) {
      const id = Number(insUser.run(`${p}@opsdesk.test`, name, pw, admin, now).lastInsertRowid);
      for (const [k, role] of Object.entries(roles)) {
        insMem.run(id, teamIds[k], role);
        if (role !== 'viewer') workers[k].push(id);
        if (role === 'lead') leads[k].push(id);
      }
    }
    const first = ['Asha', 'Ravi', 'Mei', 'Lucas', 'Fatima', 'Noah', 'Ines', 'Kenji', 'Zara', 'Mateo', 'Anya', 'Tariq', 'Elena', 'Kofi', 'Sofia', 'Arjun'];
    const last = ['Patel', 'Garcia', 'Kim', 'Okafor', 'Rossi', 'Nguyen', 'Silva', 'Shah', 'Müller', 'Haddad', 'Ito', 'Mensah'];
    for (let i = 1; i <= bulkUsers; i++) {
      const id = Number(insUser.run(`user${String(i).padStart(3, '0')}@opsdesk.test`, `${pick(first)} ${pick(last)}`, pw, 0, now).lastInsertRowid);
      const teams = new Set([pick(TEAMS)[0]]);
      if (rand() < 0.3) teams.add(pick(TEAMS)[0]);
      for (const k of teams) {
        const role = leads[k].length < 3 && rand() < 0.1 ? 'lead' : rand() < 0.1 ? 'viewer' : 'member';
        insMem.run(id, teamIds[k], role);
        if (role !== 'viewer') workers[k].push(id);
        if (role === 'lead') leads[k].push(id);
      }
    }

    const insItem = db.prepare(
      `INSERT INTO work_items (team_id, title, description, type, priority, status, requires_approval, approved_by, approved_at,
         assignee_id, reporter_id, due_at, resolution, version, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insAct = db.prepare('INSERT INTO activity (item_id, team_id, actor_id, kind, data, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insComment = db.prepare('INSERT INTO comments (item_id, author_id, body, created_at) VALUES (?, ?, ?, ?)');

    const DAY = 86400e3;
    const statusRoll = () => { const r = rand(); return r < 0.18 ? 'open' : r < 0.36 ? 'in_progress' : r < 0.42 ? 'blocked' : r < 0.47 ? 'awaiting_approval' : r < 0.72 ? 'resolved' : 'closed'; };

    for (let i = 0; i < items; i++) {
      const [key] = pick(TEAMS);
      const teamId = teamIds[key];
      const type = pick(TEAM_TYPES[key]);
      const priority = (() => { const r = rand(); return r < 0.07 ? 1 : r < 0.27 ? 2 : r < 0.75 ? 3 : 4; })();
      const requiresApproval = APPROVAL_DEFAULT_TYPES.has(type) ? 1 : 0;
      let status = statusRoll();
      if (status === 'awaiting_approval' && !requiresApproval) status = 'in_progress';
      // Older items are more likely to be finished.
      const age = Math.pow(rand(), ['resolved', 'closed'].includes(status) ? 0.6 : 2.2) * 120 * DAY;
      const created = Math.floor(now - age);
      const reporter = pick(workers[key]);
      const assignee = status === 'open' ? (rand() < 0.15 ? pick(workers[key]) : null) : pick(workers[key]);
      if (status === 'open' && assignee) status = 'in_progress';
      const updated = Math.min(now, Math.floor(created + rand() * Math.max(age, 3600e3)));
      const title = pick(TITLES[type]).replace('{n}', String(10000 + Math.floor(rand() * 89999))).replace('{region}', pick(REGIONS));
      const approved = status !== 'awaiting_approval' && requiresApproval && ['resolved', 'closed'].includes(status);
      const approver = approved ? pick(leads[key].filter((l) => l !== assignee).concat(leads[key])) || null : null;
      const version = status === 'open' ? 1 : status === 'in_progress' ? 2 : 3;
      // Finished items keep their original SLA; active ones are spread around "now" so roughly 1 in 8 is overdue.
      const due = ['resolved', 'closed'].includes(status)
        ? created + SLA_MS[priority]
        : Math.floor(now + (rand() - 0.12) * SLA_MS[priority] * 4);

      const id = Number(insItem.run(teamId, title, `Reported via ${pick(['chat', 'email', 'phone', 'spreadsheet', 'monitoring alert'])}. ${pick(COMMENTS)}`,
        type, priority, status, requiresApproval, approver, approver ? updated : null, assignee, reporter,
        due, ['resolved', 'closed'].includes(status) ? (approved ? 'approved' : 'done') : null,
        version, created, updated, updated).lastInsertRowid);

      insAct.run(id, teamId, reporter, 'created', JSON.stringify({ title, priority }), 1, created);
      if (assignee) insAct.run(id, teamId, assignee, 'claimed', JSON.stringify({ from: 'open', to: 'in_progress' }), 2, Math.floor(created + (updated - created) * 0.2));
      if (rand() < 0.5) {
        const author = pick(workers[key]);
        const at = Math.floor(created + (updated - created) * 0.5);
        const cid = Number(insComment.run(id, author, pick(COMMENTS), at).lastInsertRowid);
        insAct.run(id, teamId, author, 'commented', JSON.stringify({ commentId: cid }), null, at);
      }
      if (version === 3) insAct.run(id, teamId, approver || assignee || reporter, 'transitioned', JSON.stringify({ from: 'in_progress', to: status }), 3, updated);
    }
  })();
  db.exec("INSERT INTO work_items_fts(work_items_fts) VALUES ('optimize')");
  db.exec('ANALYZE');
  log(`Seeded ${items} work items in ${((Date.now() - started) / 1000).toFixed(1)}s. Demo accounts use password "password".`);
}

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'opsdesk.db');
  if (args.includes('--reset')) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const { openDb } = require('./db');
  const db = openDb(file);
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    console.log('Database already has data. Use --reset to recreate it.');
  } else {
    const i = args.indexOf('--items');
    seed(db, { items: i >= 0 ? Number(args[i + 1]) : 20000 });
  }
  db.close();
}

module.exports = { seed, DEMO, TEAMS };
