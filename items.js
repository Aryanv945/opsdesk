'use strict';
/**
 * Work-item business logic. Every mutating function is meant to be called
 * inside a transaction (see db.tx); each one writes the change, an activity
 * row and an outbox job atomically, so the audit trail and notifications can
 * never disagree with the data.
 */
const authz = require('../authz');
const { checkTransition, availableTransitions, SLA_MS, APPROVAL_DEFAULT_TYPES, ACTIVE } = require('../workflow');
const { notFound, forbidden, conflict, unprocessable, badRequest } = require('../errors');

const ITEM_SELECT = `
  SELECT w.*, t.key AS team_key, t.name AS team_name,
         a.name AS assignee_name, r.name AS reporter_name, ap.name AS approver_name
  FROM work_items w
  JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id
  JOIN users r ON r.id = w.reporter_id
  LEFT JOIN users ap ON ap.id = w.approved_by`;

function getRow(db, id) {
  return db.prepare(`${ITEM_SELECT} WHERE w.id = ?`).get(id);
}

/** Loads an item the user may see. Unknown and invisible items both yield 404. */
function getVisible(db, user, id) {
  const row = Number.isInteger(id) ? getRow(db, id) : null;
  if (!row || !authz.canView(user, row)) throw notFound();
  return row;
}

function toDto(row, user, now = Date.now()) {
  const active = ACTIVE.includes(row.status);
  const dto = {
    id: row.id,
    key: `${row.team_key}-${row.id}`,
    team: { id: row.team_id, key: row.team_key, name: row.team_name },
    title: row.title,
    type: row.type,
    priority: row.priority,
    status: row.status,
    requiresApproval: !!row.requires_approval,
    approvedBy: row.approved_by ? { id: row.approved_by, name: row.approver_name } : null,
    approvedAt: row.approved_at,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    reporter: { id: row.reporter_id, name: row.reporter_name },
    dueAt: row.due_at,
    overdue: active && row.due_at != null && row.due_at < now,
    resolution: row.resolution,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
  if (row.description !== undefined) dto.description = row.description;
  if (user) {
    dto.permissions = {
      edit: authz.canEdit(user, row),
      editApproval: authz.hasRole(user, row.team_id, 'lead') && ['open', 'in_progress', 'blocked'].includes(row.status),
      claim: authz.canClaim(user, row) && !row.assignee_id && ['open', 'in_progress', 'blocked'].includes(row.status),
      assign: authz.canAssignOthers(user, row) && row.status !== 'closed' && row.status !== 'awaiting_approval',
      release: !!row.assignee_id && authz.canRelease(user, row) && ['in_progress', 'blocked', 'open'].includes(row.status),
      comment: authz.canComment(user, row),
      transitions: availableTransitions(user, row),
    };
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Activity + outbox

function record(db, item, actorId, kind, data, version, now) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO activity (item_id, team_id, actor_id, kind, data, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(item.id, item.team_id, actorId, kind, JSON.stringify(data || {}), version, now);
  const activityId = Number(lastInsertRowid);
  db.prepare(`INSERT INTO jobs (kind, payload, run_after, created_at) VALUES ('notify', ?, ?, ?)`)
    .run(JSON.stringify({ activityId }), now, now);
  return activityId;
}

/**
 * Applies `set` to the item only if its version still equals `expectedVersion`.
 * The version check lives in the WHERE clause, so it stays correct under any
 * isolation level and across multiple app servers.
 */
function guardedUpdate(db, item, expectedVersion, set, now) {
  const cols = Object.keys(set);
  const sql = `UPDATE work_items SET ${cols.map((c) => `${c} = @${c}`).join(', ')},
                 version = version + 1, updated_at = @__now, last_activity_at = @__now
               WHERE id = @__id AND version = @__expected`;
  const info = db.prepare(sql).run({ ...set, __now: now, __id: item.id, __expected: expectedVersion });
  if (info.changes === 0) throw versionConflict(db, item.id, expectedVersion);
  return expectedVersion + 1;
}

function versionConflict(db, id, expectedVersion) {
  const current = getRow(db, id);
  const changes = db.prepare(
    `SELECT a.kind, a.data, a.version, a.created_at, u.name AS actor
     FROM activity a JOIN users u ON u.id = a.actor_id
     WHERE a.item_id = ? AND a.version > ? ORDER BY a.id`
  ).all(id, expectedVersion).map((c) => ({ ...c, data: JSON.parse(c.data) }));
  return conflict('VERSION_CONFLICT',
    'This item was changed by someone else after you loaded it. Review the latest version and try again.',
    { currentVersion: current.version, yourVersion: expectedVersion, changes, current: toDto(current) });
}

function requireVersion(v) {
  if (!Number.isInteger(v)) throw badRequest('expectedVersion is required for this change');
}

// ---------------------------------------------------------------------------
// Commands

function createItem(db, user, input, now = Date.now()) {
  if (!authz.canCreateIn(user, input.teamId)) {
    // Do not reveal whether a team the user cannot see exists.
    throw authz.roleIn(user, input.teamId) ? forbidden('Viewers cannot create work items') : notFound('Team');
  }
  if (input.assigneeId != null && !authz.isAssignable(db, input.assigneeId, input.teamId)) {
    throw unprocessable('INVALID_ASSIGNEE', 'Assignee must be a member of the team');
  }
  if (input.assigneeId != null && input.assigneeId !== user.id && !authz.hasRole(user, input.teamId, 'lead')) {
    throw forbidden('Only team leads can assign work to someone else');
  }
  const requiresApproval = input.requiresApproval ?? APPROVAL_DEFAULT_TYPES.has(input.type);
  const status = input.assigneeId != null ? 'in_progress' : 'open';
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO work_items (team_id, title, description, type, priority, status, requires_approval,
                             assignee_id, reporter_id, due_at, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.teamId, input.title, input.description || '', input.type, input.priority, status,
    requiresApproval ? 1 : 0, input.assigneeId ?? null, user.id, input.dueAt ?? now + SLA_MS[input.priority], now, now, now);
  const item = getRow(db, Number(lastInsertRowid));
  record(db, item, user.id, 'created', { title: item.title, priority: item.priority, assigneeId: item.assignee_id }, 1, now);
  return item;
}

const EDITABLE = { title: 'title', description: 'description', priority: 'priority', type: 'type', dueAt: 'due_at', requiresApproval: 'requires_approval' };

function updateItem(db, user, id, { expectedVersion, changes }, now = Date.now()) {
  const item = getVisible(db, user, id);
  if (!authz.canEdit(user, item)) throw forbidden(item.status === 'closed' ? 'Closed items cannot be edited; reopen it first' : undefined);
  requireVersion(expectedVersion);

  const set = {};
  const diff = {};
  for (const [field, col] of Object.entries(EDITABLE)) {
    if (!(field in changes)) continue;
    let value = changes[field];
    if (field === 'requiresApproval') {
      value = value ? 1 : 0;
      if (value !== item.requires_approval) {
        if (!authz.hasRole(user, item.team_id, 'lead')) throw forbidden('Only team leads can change approval requirements');
        if (!['open', 'in_progress', 'blocked'].includes(item.status)) {
          throw unprocessable('INVALID_STATE', 'Approval requirements cannot change once approval has been requested');
        }
      }
    }
    if (value !== item[col]) {
      set[col] = value;
      diff[field] = { from: field === 'requiresApproval' ? !!item[col] : item[col], to: field === 'requiresApproval' ? !!value : value };
    }
  }
  if (Object.keys(set).length === 0) {
    // Nothing changed. Still reject a stale version so the client learns it is behind.
    if (item.version !== expectedVersion) throw versionConflict(db, item.id, expectedVersion);
    return item;
  }
  const version = guardedUpdate(db, item, expectedVersion, set, now);
  // Keep description diffs small in the audit log.
  if (diff.description) diff.description = { changed: true };
  record(db, item, user.id, 'updated', { changes: diff }, version, now);
  return getRow(db, id);
}

/**
 * Take responsibility for an unassigned item. Two people clicking "Claim" at
 * the same moment race on `assignee_id IS NULL` in the WHERE clause; exactly
 * one UPDATE matches, the other gets a 409 naming the winner. Claiming an item
 * you already own is a no-op success, which makes retries harmless.
 */
function claimItem(db, user, id, now = Date.now()) {
  const item = getVisible(db, user, id);
  if (!authz.canClaim(user, item)) throw forbidden('Viewers cannot claim work');
  const info = db.prepare(
    `UPDATE work_items
       SET assignee_id = @user, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
           version = version + 1, updated_at = @now, last_activity_at = @now
     WHERE id = @id AND assignee_id IS NULL AND status IN ('open','in_progress','blocked')`
  ).run({ user: user.id, now, id });

  if (info.changes === 0) {
    const current = getRow(db, id);
    if (current.assignee_id === user.id) return { item: current, alreadyOwned: true };
    if (current.assignee_id) {
      throw conflict('ALREADY_CLAIMED', `${current.assignee_name} has already taken this item`,
        { assignee: { id: current.assignee_id, name: current.assignee_name }, current: toDto(current, user, now) });
    }
    throw unprocessable('INVALID_STATE', `Items that are ${current.status.replace('_', ' ')} cannot be claimed`);
  }
  const updated = getRow(db, id);
  record(db, updated, user.id, 'claimed', { from: item.status, to: updated.status }, updated.version, now);
  return { item: updated, alreadyOwned: false };
}

function assignItem(db, user, id, { assigneeId, expectedVersion }, now = Date.now()) {
  const item = getVisible(db, user, id);
  if (!authz.canAssignOthers(user, item)) {
    throw forbidden(assigneeId === user.id ? 'Use "Claim" to take this item yourself' : 'Only team leads can assign work to others');
  }
  requireVersion(expectedVersion);
  if (['closed', 'awaiting_approval'].includes(item.status)) {
    throw unprocessable('INVALID_STATE', `Cannot reassign an item that is ${item.status.replace('_', ' ')}`);
  }
  if (assigneeId != null && !authz.isAssignable(db, assigneeId, item.team_id)) {
    throw unprocessable('INVALID_ASSIGNEE', 'Assignee must be a member or lead of the item\'s team');
  }
  if (assigneeId === item.assignee_id) {
    if (item.version !== expectedVersion) throw versionConflict(db, item.id, expectedVersion);
    return item;
  }
  const set = { assignee_id: assigneeId ?? null };
  if (assigneeId == null && ['in_progress', 'blocked'].includes(item.status)) set.status = 'open';
  if (assigneeId != null && item.status === 'open') set.status = 'in_progress';
  const version = guardedUpdate(db, item, expectedVersion, set, now);
  record(db, item, user.id, 'assigned', { from: item.assignee_id, to: assigneeId ?? null, status: set.status }, version, now);
  return getRow(db, id);
}

function releaseItem(db, user, id, { expectedVersion }, now = Date.now()) {
  const item = getVisible(db, user, id);
  if (!item.assignee_id) throw unprocessable('NOT_ASSIGNED', 'This item is not assigned');
  if (!authz.canRelease(user, item)) throw forbidden('Only the assignee or a team lead can release this item');
  if (!['open', 'in_progress', 'blocked'].includes(item.status)) {
    throw unprocessable('INVALID_STATE', `Cannot release an item that is ${item.status.replace('_', ' ')}`);
  }
  requireVersion(expectedVersion);
  const set = { assignee_id: null, status: 'open' };
  const version = guardedUpdate(db, item, expectedVersion, set, now);
  record(db, item, user.id, 'released', { from: item.assignee_id }, version, now);
  return getRow(db, id);
}

function transitionItem(db, user, id, { to, note, expectedVersion }, now = Date.now()) {
  const item = getVisible(db, user, id);
  requireVersion(expectedVersion);
  // Check the version first: rules evaluated against a stale view would be meaningless to the user.
  if (item.version !== expectedVersion) throw versionConflict(db, item.id, expectedVersion);
  const edge = checkTransition(user, item, to, note);

  const set = { status: to };
  if (edge.resolution) set.resolution = note?.trim() ? `${edge.resolution}: ${note.trim()}` : edge.resolution;
  if (to === 'in_progress' || to === 'open') set.resolution = null;
  if (edge.approves) { set.approved_by = user.id; set.approved_at = now; }
  if (item.status === 'awaiting_approval' && to === 'in_progress') { set.approved_by = null; set.approved_at = null; }
  if (item.status === 'closed' && to === 'open') { set.approved_by = null; set.approved_at = null; }
  if (edge.clearsAssignee) set.assignee_id = null;

  const version = guardedUpdate(db, item, expectedVersion, set, now);
  record(db, item, user.id, 'transitioned', { from: item.status, to, note: note?.trim() || undefined }, version, now);
  return getRow(db, id);
}

function addComment(db, user, id, { body }, now = Date.now()) {
  const item = getVisible(db, user, id);
  if (!authz.canComment(user, item)) throw forbidden();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO comments (item_id, author_id, body, created_at) VALUES (?, ?, ?, ?)`
  ).run(item.id, user.id, body, now);
  // Comments do not bump the item version: discussing an item should never
  // cause someone else's field edit to fail with a conflict.
  db.prepare(`UPDATE work_items SET last_activity_at = ? WHERE id = ?`).run(now, item.id);
  const commentId = Number(lastInsertRowid);
  const activityId = record(db, item, user.id, 'commented', { commentId }, null, now);
  return { id: commentId, activityId, itemId: item.id, body, createdAt: now, author: { id: user.id, name: user.name } };
}

// ---------------------------------------------------------------------------
// Queries

function timeline(db, user, id, { before, limit = 50 }) {
  const item = getVisible(db, user, id);
  const rows = db.prepare(
    `SELECT a.id, a.kind, a.data, a.version, a.created_at, a.actor_id, u.name AS actor_name, c.body AS comment_body
     FROM activity a
     JOIN users u ON u.id = a.actor_id
     LEFT JOIN comments c ON a.kind = 'commented' AND c.id = json_extract(a.data, '$.commentId')
     WHERE a.item_id = ? AND (? IS NULL OR a.id < ?)
     ORDER BY a.id DESC LIMIT ?`
  ).all(item.id, before ?? null, before ?? null, limit + 1);
  const page = rows.slice(0, limit);
  const names = userNames(db, page);
  return {
    entries: page.map((r) => ({
      id: r.id, kind: r.kind, version: r.version, createdAt: r.created_at,
      actor: { id: r.actor_id, name: r.actor_name },
      data: r.kind === 'commented' ? { body: r.comment_body } : withNames(JSON.parse(r.data), names),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

// Resolve user ids mentioned in assignment events so the timeline is readable.
function userNames(db, rows) {
  const ids = new Set();
  for (const r of rows) {
    if (r.kind === 'assigned' || r.kind === 'released' || r.kind === 'created') {
      const d = JSON.parse(r.data);
      for (const k of ['from', 'to', 'assigneeId']) if (Number.isInteger(d[k])) ids.add(d[k]);
    }
  }
  if (!ids.size) return new Map();
  const list = [...ids];
  return new Map(db.prepare(`SELECT id, name FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list).map((u) => [u.id, u.name]));
}
function withNames(data, names) {
  for (const k of ['from', 'to', 'assigneeId']) {
    if (Number.isInteger(data[k]) && names.has(data[k])) data[`${k}Name`] = names.get(data[k]);
  }
  return data;
}

module.exports = {
  ITEM_SELECT, getRow, getVisible, toDto, record,
  createItem, updateItem, claimItem, assignItem, releaseItem, transitionItem, addComment, timeline,
};
