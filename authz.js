'use strict';
/**
 * Authorization policy. Every rule lives here and is enforced on the server;
 * the UI only *mirrors* these rules (via `permissions` on each item) to hide
 * controls that would fail anyway.
 *
 * Roles are per team:
 *   viewer – read items and comment (stakeholders, management)
 *   member – create, edit, claim, work items through the workflow
 *   lead   – everything a member can do, plus assign others, approve, close and reopen
 * Global admins act as `lead` in every team.
 */
const RANK = { viewer: 1, member: 2, lead: 3 };

function roleIn(user, teamId) {
  if (user.isAdmin) return 'lead';
  return user.roles.get(teamId) || null;
}

function hasRole(user, teamId, min) {
  const role = roleIn(user, teamId);
  return !!role && RANK[role] >= RANK[min];
}

/** Team ids the user may read, or null meaning "all teams" (admin). */
function visibleTeamIds(user) {
  return user.isAdmin ? null : [...user.roles.keys()];
}

const canView = (user, item) => hasRole(user, item.team_id, 'viewer');
const canComment = canView;
const canCreateIn = (user, teamId) => hasRole(user, teamId, 'member');
const canEdit = (user, item) => hasRole(user, item.team_id, 'member') && item.status !== 'closed';
const canClaim = (user, item) => hasRole(user, item.team_id, 'member');
const canAssignOthers = (user, item) => hasRole(user, item.team_id, 'lead');
const canRelease = (user, item) => item.assignee_id === user.id || hasRole(user, item.team_id, 'lead');

/** Only people who can actually do work in the team may be assigned. */
function isAssignable(db, userId, teamId) {
  const row = db.prepare(`SELECT role FROM memberships WHERE user_id = ? AND team_id = ?`).get(userId, teamId);
  return !!row && RANK[row.role] >= RANK.member;
}

module.exports = {
  RANK, roleIn, hasRole, visibleTeamIds,
  canView, canComment, canCreateIn, canEdit, canClaim, canAssignOthers, canRelease, isAssignable,
};
