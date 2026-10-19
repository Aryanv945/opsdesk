'use strict';
/**
 * The work-item state machine. Each allowed edge declares who may take it and
 * what must be true. Anything not listed is rejected — the server never trusts
 * the client to only offer valid transitions.
 *
 *   open ──▶ in_progress ──▶ resolved ──▶ closed
 *              │   ▲  │          │  ▲         │
 *              ▼   │  └▶ awaiting_approval ─┘  (reopen paths need a note)
 *            blocked
 */
const { hasRole } = require('./authz');
const { forbidden, unprocessable } = require('./errors');

const STATUSES = ['open', 'in_progress', 'blocked', 'awaiting_approval', 'resolved', 'closed'];
const ACTIVE = ['open', 'in_progress', 'blocked', 'awaiting_approval'];

// actor: who may perform the transition
//   assigneeOrLead | lead | reporterOrLead | member
const EDGES = {
  'open>in_progress':            { actor: 'assigneeOrLead', needsAssignee: true, label: 'Start work' },
  'open>closed':                 { actor: 'lead', needsNote: true, label: 'Cancel', resolution: 'cancelled' },
  'in_progress>blocked':         { actor: 'assigneeOrLead', needsNote: true, label: 'Mark blocked' },
  'blocked>in_progress':         { actor: 'assigneeOrLead', label: 'Unblock' },
  'in_progress>awaiting_approval': { actor: 'assigneeOrLead', when: 'requiresApproval', label: 'Request approval' },
  'in_progress>resolved':        { actor: 'assigneeOrLead', when: 'noApproval', label: 'Resolve', resolution: 'done' },
  'awaiting_approval>resolved':  { actor: 'lead', separationOfDuties: true, label: 'Approve', resolution: 'approved', approves: true },
  'awaiting_approval>in_progress': { actor: 'lead', needsNote: true, label: 'Reject' },
  'resolved>closed':             { actor: 'reporterOrLead', label: 'Close' },
  'resolved>in_progress':        { actor: 'member', needsNote: true, needsAssignee: true, label: 'Reopen' },
  'closed>open':                 { actor: 'lead', needsNote: true, label: 'Reopen', clearsAssignee: true },
};

function actorAllowed(user, item, actor) {
  const isLead = hasRole(user, item.team_id, 'lead');
  switch (actor) {
    case 'lead': return isLead;
    case 'assigneeOrLead': return isLead || item.assignee_id === user.id;
    case 'reporterOrLead': return isLead || item.reporter_id === user.id;
    case 'member': return hasRole(user, item.team_id, 'member');
    default: return false;
  }
}

/** Throws if the transition is not allowed; returns the edge definition otherwise. */
function checkTransition(user, item, to, note) {
  if (!STATUSES.includes(to)) throw unprocessable('INVALID_STATUS', `Unknown status "${to}"`);
  const edge = EDGES[`${item.status}>${to}`];
  if (!edge) {
    throw unprocessable('INVALID_TRANSITION', `Cannot move from ${item.status} to ${to}`, { from: item.status, to });
  }
  if (!actorAllowed(user, item, edge.actor)) {
    const who = { lead: 'a team lead', assigneeOrLead: 'the assignee or a team lead', reporterOrLead: 'the reporter or a team lead', member: 'a team member' }[edge.actor];
    throw forbidden(`Only ${who} can ${edge.label.toLowerCase()} this item`);
  }
  if (edge.when === 'requiresApproval' && !item.requires_approval) {
    throw unprocessable('APPROVAL_NOT_REQUIRED', 'This item does not require approval; resolve it directly');
  }
  if (edge.when === 'noApproval' && item.requires_approval) {
    throw unprocessable('APPROVAL_REQUIRED', 'This item requires approval before it can be resolved');
  }
  if (edge.needsAssignee && !item.assignee_id) {
    throw unprocessable('ASSIGNEE_REQUIRED', 'Assign or claim this item first');
  }
  if (edge.needsNote && !(note && note.trim())) {
    throw unprocessable('NOTE_REQUIRED', `A note is required to ${edge.label.toLowerCase()}`);
  }
  if (edge.separationOfDuties && item.assignee_id === user.id) {
    throw forbidden('You cannot approve work assigned to you; another lead must approve it');
  }
  return edge;
}

/** The transitions this user could take right now (used by the UI to render buttons). */
function availableTransitions(user, item) {
  const out = [];
  for (const [key, edge] of Object.entries(EDGES)) {
    const [from, to] = key.split('>');
    if (from !== item.status) continue;
    try {
      checkTransition(user, item, to, 'x');
      out.push({ to, label: edge.label, needsNote: !!edge.needsNote });
    } catch { /* not available */ }
  }
  return out;
}

/** Default response-time targets by priority, used when a due date is not given. */
const SLA_MS = { 1: 4 * 3600e3, 2: 24 * 3600e3, 3: 3 * 86400e3, 4: 7 * 86400e3 };
const APPROVAL_DEFAULT_TYPES = new Set(['payment', 'compliance']);

module.exports = { STATUSES, ACTIVE, EDGES, checkTransition, availableTransitions, SLA_MS, APPROVAL_DEFAULT_TYPES };
