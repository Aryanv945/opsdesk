export const STATUS_LABEL = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval', resolved: 'Resolved', closed: 'Closed',
};
export const TYPE_LABEL = {
  incident: 'Incident', customer_issue: 'Customer issue', engineering: 'Engineering',
  payment: 'Payment', compliance: 'Compliance', task: 'Task',
};
export const PRIORITY_LABEL = { 1: 'P1 Urgent', 2: 'P2 High', 3: 'P3 Normal', 4: 'P4 Low' };

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
export function relative(ts, now = Date.now()) {
  if (ts == null) return '—';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units = [['day', 86400e3], ['hour', 3600e3], ['minute', 60e3]];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return 'just now';
}

export function absolute(ts) {
  if (ts == null) return '';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact due label for dense rows: "in 19h", "3d overdue". */
export function dueLabel(item, now = Date.now()) {
  if (['resolved', 'closed'].includes(item.status)) return `done ${short(now - item.updatedAt)} ago`;
  if (item.dueAt == null) return '';
  const diff = item.dueAt - now;
  return diff < 0 ? `${short(-diff)} overdue` : `in ${short(diff)}`;
}
function short(ms) {
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))}m`;
  if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h`;
  return `${Math.round(ms / 86400e3)}d`;
}
