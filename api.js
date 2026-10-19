'use strict';
const express = require('express');
const { z } = require('zod');
const { tx } = require('../db');
const auth = require('../auth');
const authz = require('../authz');
const items = require('../services/items');
const queries = require('../services/queries');
const { runIdempotent } = require('../idempotency');
const { badRequest, unauthenticated, notFound } = require('../errors');
const { STATUSES } = require('../workflow');

const TYPES = ['incident', 'customer_issue', 'engineering', 'payment', 'compliance', 'task'];

const schemas = {
  login: z.object({ email: z.string().email(), password: z.string().min(1) }),
  create: z.object({
    teamId: z.number().int().positive(),
    title: z.string().trim().min(3).max(200),
    description: z.string().max(20_000).optional(),
    type: z.enum(TYPES),
    priority: z.number().int().min(1).max(4),
    assigneeId: z.number().int().positive().nullable().optional(),
    requiresApproval: z.boolean().optional(),
    dueAt: z.number().int().positive().optional(),
  }).strict(),
  update: z.object({
    expectedVersion: z.number().int().positive(),
    changes: z.object({
      title: z.string().trim().min(3).max(200),
      description: z.string().max(20_000),
      priority: z.number().int().min(1).max(4),
      type: z.enum(TYPES),
      dueAt: z.number().int().positive(),
      requiresApproval: z.boolean(),
    }).partial().strict(),
  }).strict(),
  versioned: z.object({ expectedVersion: z.number().int().positive() }).strict(),
  assign: z.object({ assigneeId: z.number().int().positive().nullable(), expectedVersion: z.number().int().positive() }).strict(),
  transition: z.object({ to: z.enum(STATUSES), note: z.string().max(5000).optional(), expectedVersion: z.number().int().positive() }).strict(),
  comment: z.object({ body: z.string().trim().min(1).max(10_000) }).strict(),
};

function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('Request is invalid', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const itemId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
};

const csv = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
function parseListQuery(q) {
  const f = {
    teamId: q.teamId ? Number(q.teamId) : undefined,
    status: csv(q.status),
    priority: csv(q.priority)?.map(Number),
    type: csv(q.type),
    assignee: q.assignee === 'me' || q.assignee === 'unassigned' ? q.assignee : q.assignee ? Number(q.assignee) : undefined,
    reporter: q.reporter === 'me' ? 'me' : undefined,
    overdue: q.overdue === '1' || q.overdue === 'true',
    awaitingMyApproval: q.awaitingMyApproval === '1' || q.awaitingMyApproval === 'true',
    q: typeof q.q === 'string' && q.q.trim() ? q.q.slice(0, 200) : undefined,
    sort: q.sort || 'updated',
    cursor: q.cursor || undefined,
    limit: q.limit ? Number(q.limit) : 50,
  };
  if (!queries.SORTS[f.sort]) throw badRequest(`Unknown sort "${f.sort}"`);
  if (f.status?.some((s) => s !== 'active' && !STATUSES.includes(s))) throw badRequest('Unknown status filter');
  if (f.priority?.some((p) => !(p >= 1 && p <= 4))) throw badRequest('Unknown priority filter');
  if (f.type?.some((t) => !TYPES.includes(t))) throw badRequest('Unknown type filter');
  if (f.teamId !== undefined && !Number.isInteger(f.teamId)) throw badRequest('Invalid teamId');
  if (f.assignee !== undefined && typeof f.assignee === 'number' && !Number.isInteger(f.assignee)) throw badRequest('Invalid assignee');
  return f;
}

function createApiRouter(db, { live } = {}) {
  const r = express.Router();
  const requireAuth = auth.requireAuth(db);
  const cookie = (token, maxAge) =>
    `${auth.SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

  // ---- session -----------------------------------------------------------
  r.post('/auth/login', (req, res) => {
    const { email, password } = parse(schemas.login, req.body);
    const u = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    // Same error whether the user exists or not.
    if (!u || !auth.verifyPassword(password, u.password_hash)) throw unauthenticated();
    const token = auth.createSession(db, u.id);
    res.set('Set-Cookie', cookie(token, auth.SESSION_TTL_MS / 1000));
    res.json({ user: publicUser(auth.loadUser(db, u.id)) });
  });

  // Demo convenience: the login screen lists the seeded accounts. Disabled in production.
  r.get('/auth/demo-users', (_req, res) => {
    if (process.env.NODE_ENV === 'production') throw notFound('Route');
    res.json({ users: db.prepare(`
      SELECT u.email, u.name, u.is_admin, GROUP_CONCAT(t.key || ':' || m.role, ', ') AS roles
      FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN teams t ON t.id = m.team_id
      WHERE u.email LIKE '%@opsdesk.test' AND u.email NOT LIKE 'user%' GROUP BY u.id ORDER BY u.id`).all() });
  });

  r.use(requireAuth);

  r.post('/auth/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    res.set('Set-Cookie', cookie('', 0));
    res.status(204).end();
  });

  r.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  // ---- teams -------------------------------------------------------------
  r.get('/teams', (req, res) => {
    const visible = authz.visibleTeamIds(req.user);
    const rows = visible === null
      ? db.prepare('SELECT id, key, name FROM teams ORDER BY name').all()
      : visible.length ? db.prepare(`SELECT id, key, name FROM teams WHERE id IN (${visible.map(() => '?').join(',')}) ORDER BY name`).all(...visible) : [];
    res.json({ teams: rows.map((t) => ({ ...t, role: authz.roleIn(req.user, t.id) })) });
  });

  r.get('/teams/:id/members', (req, res) => {
    const teamId = Number(req.params.id);
    if (!authz.hasRole(req.user, teamId, 'viewer')) throw notFound('Team');
    res.json({ members: db.prepare(
      `SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, u.name`
    ).all(teamId) });
  });

  // ---- reads -------------------------------------------------------------
  r.get('/dashboard', (req, res) => res.json(queries.dashboard(db, req.user)));

  r.get('/items', (req, res) => res.json(queries.listItems(db, req.user, parseListQuery(req.query))));

  r.get('/items/:id', (req, res) => {
    const row = items.getVisible(db, req.user, itemId(req));
    res.set('ETag', `"${row.version}"`);
    res.json({ item: items.toDto(row, req.user) });
  });

  r.get('/items/:id/activity', (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    res.json(items.timeline(db, req.user, itemId(req), { before, limit: Math.min(Number(req.query.limit) || 50, 100) }));
  });

  // ---- writes (all idempotent when an Idempotency-Key is supplied) -------
  const dto = (req, row) => ({ item: items.toDto(row, req.user) });

  r.post('/items', (req, res) => {
    const input = parse(schemas.create, req.body);
    runIdempotent(db, req, res, () => ({ status: 201, body: dto(req, items.createItem(db, req.user, input)) }));
  });

  r.patch('/items/:id', (req, res) => {
    const input = parse(schemas.update, req.body);
    const id = itemId(req);
    runIdempotent(db, req, res, () => ({ status: 200, body: dto(req, items.updateItem(db, req.user, id, input)) }));
  });

  r.post('/items/:id/claim', (req, res) => {
    const id = itemId(req);
    runIdempotent(db, req, res, () => {
      const { item, alreadyOwned } = items.claimItem(db, req.user, id);
      return { status: 200, body: { ...dto(req, item), alreadyOwned } };
    });
  });

  r.post('/items/:id/assign', (req, res) => {
    const input = parse(schemas.assign, req.body);
    const id = itemId(req);
    runIdempotent(db, req, res, () => ({ status: 200, body: dto(req, items.assignItem(db, req.user, id, input)) }));
  });

  r.post('/items/:id/release', (req, res) => {
    const input = parse(schemas.versioned, req.body);
    const id = itemId(req);
    runIdempotent(db, req, res, () => ({ status: 200, body: dto(req, items.releaseItem(db, req.user, id, input)) }));
  });

  r.post('/items/:id/transition', (req, res) => {
    const input = parse(schemas.transition, req.body);
    const id = itemId(req);
    runIdempotent(db, req, res, () => ({ status: 200, body: dto(req, items.transitionItem(db, req.user, id, input)) }));
  });

  r.post('/items/:id/comments', (req, res) => {
    const input = parse(schemas.comment, req.body);
    const id = itemId(req);
    runIdempotent(db, req, res, () => ({ status: 201, body: { comment: items.addComment(db, req.user, id, input) } }));
  });

  // ---- notifications -----------------------------------------------------
  r.get('/notifications', (req, res) => {
    const list = db.prepare(
      `SELECT n.id, n.item_id AS itemId, n.message, n.created_at AS createdAt, n.read_at AS readAt
       FROM notifications n WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`
    ).all(req.user.id);
    const { unread } = db.prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id);
    res.json({ notifications: list, unread });
  });

  r.post('/notifications/read', (req, res) => {
    // Marking read is naturally idempotent.
    tx(db, () => db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id));
    res.status(204).end();
  });

  // ---- live updates ------------------------------------------------------
  if (live) r.get('/events', live.handler);

  return r;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, memberships: u.memberships };
}

module.exports = { createApiRouter, parseListQuery };
