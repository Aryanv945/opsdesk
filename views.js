// Saved views: the questions people ask most often, each a fixed set of filters.
export const VIEWS = {
  mine:       { label: 'My work', hint: 'Active items assigned to you', filters: { assignee: 'me', status: ['active'], sort: 'priority' } },
  unassigned: { label: 'Unassigned urgent', hint: 'P1–P2 items nobody has taken', filters: { assignee: 'unassigned', status: ['open', 'blocked'], priority: [1, 2], sort: 'priority' } },
  approvals:  { label: 'Awaiting my approval', hint: 'Work in your teams waiting on a lead', filters: { awaitingMyApproval: true, sort: 'updated' } },
  overdue:    { label: 'Overdue', hint: 'Active items past their due time', filters: { overdue: true, sort: 'due' } },
  blocked:    { label: 'Blocked', hint: 'Items waiting on something', filters: { status: ['blocked'], sort: 'priority' } },
  reported:   { label: 'Reported by me', hint: 'Active items you raised', filters: { reporter: 'me', status: ['active'], sort: 'updated' } },
  all:        { label: 'All work', hint: 'Everything in your teams', filters: { sort: 'updated' } },
};

export const DASHBOARD_COUNTS = [
  ['mine', 'mine'],
  ['unassigned', 'unassignedUrgent'],
  ['approvals', 'awaitingMyApproval'],
  ['overdue', 'overdue'],
  ['blocked', 'blocked'],
];
