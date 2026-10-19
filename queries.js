'use strict';
/**
 * Read models: the filterable work list and the "what needs attention" dashboard.
 * Both are always scoped to the teams the caller can see, and the list uses
 * keyset (cursor) pagination so page N costs the same as page 1 and rows do not
 * shift or repeat while other people are editing.
 */
const authz = require('../authz');
const { ITEM_SELECT, toDto } = require('./items');
const { ACTIVE } = require('../workflow');
const { badRequest } = require('../errors');

const ACTIVE_SQL = `w.status IN (${ACTIVE.map((s) => `'${s}'`).join(',')})`;

const SORTS = {
  // [sql expression, direction, property on the row used to build the cursor]
  updated:  [['w.updated_at', 'DESC', 'updated_at'], ['w.id', 'DESC', 'id']],
  priority: [['w.priority', 'ASC', 'priority'], ['w.updated_at', 'DESC', 'updated_at'], ['w.id', 'DESC', 'id']],
  due:      [['w.due_at', 'ASC', 'due_at'], ['w.id', 'ASC', 'id']],
  created:  [['w.id', 'DESC', 'id']],
};

const encodeCursor = (values) => Buffer.from(JSON.stringify(values)).toString('base64url');
function decodeCursor(cursor, n) {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number')) return v;
  } catch { /* fall through */ }
  throw badRequest('Invalid cursor');
}

/** Builds "(a,b,c) is after (x,y,z)" for mixed sort directions. */
function keysetCondition(cols, values, params) {
  const ors = [];
  for (let i = 0; i < cols.length; i++) {
    const ands = [];
    for (let j = 0; j < i; j++) { ands.push(`${cols[j][0]} = ?`); params.push(values[j]); }
    ands.push(`${cols[i][0]} ${cols[i][1] === 'ASC' ? '>' : '<'} ?`);
    params.push(values[i]);
    ors.push(`(${ands.join(' AND ')})`);
  }
  return `(${ors.join(' OR ')})`;
}

/** Turns free text into a safe FTS5 query: every word must match as a prefix. */
function ftsQuery(q) {
  const words = q.match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map((w) => `"${w}"*`).join(' ');
}

function scope(user, where, params) {
  const teams = authz.visibleTeamIds(user);
  if (teams === null) return;
  if (teams.length === 0) { where.push('0'); return; }
  where.push(`w.team_id IN (${teams.map(() => '?').join(',')})`);
  params.push(...teams);
}

function leadTeams(user) {
  if (user.isAdmin) return null;
  return [...user.roles.entries()].filter(([, r]) => r === 'lead').map(([t]) => t);
}

function buildFilters(user, f, now) {
  const where = [];
  const params = [];
  scope(user, where, params);

  if (f.teamId) { where.push('w.team_id = ?'); params.push(f.teamId); }
  if (f.status?.length) {
    const statuses = f.status.includes('active') ? [...new Set([...f.status.filter((s) => s !== 'active'), ...ACTIVE])] : f.status;
    if (statuses.length === ACTIVE.length && ACTIVE.every((x) => statuses.includes(x))) {
      // Literal (not bound) so the planner can match the partial "active" indexes.
      where.push(ACTIVE_SQL);
    } else {
      where.push(`w.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses);
    }
  }
  if (f.priority?.length) { where.push(`w.priority IN (${f.priority.map(() => '?').join(',')})`); params.push(...f.priority); }
  if (f.type?.length) { where.push(`w.type IN (${f.type.map(() => '?').join(',')})`); params.push(...f.type); }
  if (f.assignee === 'me') { where.push('w.assignee_id = ?'); params.push(user.id); }
  else if (f.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (Number.isInteger(f.assignee)) { where.push('w.assignee_id = ?'); params.push(f.assignee); }
  if (f.reporter === 'me') { where.push('w.reporter_id = ?'); params.push(user.id); }
  if (f.overdue) {
    where.push(`${ACTIVE_SQL} AND w.due_at < ?`); params.push(now);
  }
  if (f.awaitingMyApproval) {
    where.push(`w.status = 'awaiting_approval' AND (w.assignee_id IS NULL OR w.assignee_id <> ?)`); params.push(user.id);
    const lt = leadTeams(user);
    if (lt !== null) {
      if (!lt.length) where.push('0');
      else { where.push(`w.team_id IN (${lt.map(() => '?').join(',')})`); params.push(...lt); }
    }
  }
  if (f.q) {
    const q = f.q.trim();
    const key = q.match(/^(?:[a-z]+-)?#?(\d+)$/i);
    const fts = ftsQuery(q);
    if (key && fts) {
      where.push(`(w.id = ? OR w.id IN (SELECT rowid FROM work_items_fts WHERE work_items_fts MATCH ?))`); params.push(Number(key[1]), fts);
    } else if (fts) {
      where.push(`w.id IN (SELECT rowid FROM work_items_fts WHERE work_items_fts MATCH ?)`); params.push(fts);
    }
  }
  return { where, params };
}

function listItems(db, user, f, now = Date.now()) {
  const sort = SORTS[f.sort || 'updated'];
  const limit = Math.min(Math.max(f.limit || 50, 1), 100);
  const { where, params } = buildFilters(user, f, now);

  // Total is only computed for the first page; later pages don't need it.
  const total = f.cursor ? undefined
    : db.prepare(`SELECT COUNT(*) AS n FROM work_items w ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...params).n;

  const pageWhere = [...where];
  const pageParams = [...params];
  if (f.cursor) pageWhere.push(keysetCondition(sort, decodeCursor(f.cursor, sort.length), pageParams));

  const rows = db.prepare(
    `${ITEM_SELECT.replace('SELECT w.*', 'SELECT w.id, w.team_id, w.title, w.type, w.priority, w.status, w.requires_approval, w.approved_by, w.approved_at, w.assignee_id, w.reporter_id, w.due_at, w.resolution, w.version, w.created_at, w.updated_at, w.last_activity_at')}
     ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
     ORDER BY ${sort.map(([c, d]) => `${c} ${d}`).join(', ')}
     LIMIT ?`
  ).all(...pageParams, limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDto(r, null, now)),
    nextCursor: rows.length > limit ? encodeCursor(sort.map(([, , prop]) => last[prop])) : null,
    total,
  };
}

function dashboard(db, user, now = Date.now()) {
  const count = (filters) => {
    const { where, params } = buildFilters(user, filters, now);
    return db.prepare(`SELECT COUNT(*) AS n FROM work_items w WHERE ${where.length ? where.join(' AND ') : '1'}`).get(...params).n;
  };
  const counts = {
    mine: count({ assignee: 'me', status: ['active'] }),
    unassignedUrgent: count({ assignee: 'unassigned', status: ['open', 'blocked'], priority: [1, 2] }),
    awaitingMyApproval: count({ awaitingMyApproval: true }),
    overdue: count({ overdue: true }),
    blocked: count({ status: ['blocked'] }),
  };

  const { where, params } = buildFilters(user, { status: ['active'] }, now);
  const byTeam = db.prepare(
    `SELECT t.id, t.key, t.name, w.status, COUNT(*) AS n
     FROM work_items w JOIN teams t ON t.id = w.team_id
     WHERE ${where.join(' AND ')} GROUP BY t.id, w.status ORDER BY t.name`
  ).all(...params);
  const teams = new Map();
  for (const r of byTeam) {
    if (!teams.has(r.id)) teams.set(r.id, { id: r.id, key: r.key, name: r.name, counts: {} });
    teams.get(r.id).counts[r.status] = r.n;
  }
  return { counts, teams: [...teams.values()], generatedAt: now };
}

module.exports = { listItems, dashboard, ftsQuery, keysetCondition, SORTS };
