import { STATUS_LABEL, absolute, dueLabel } from '../lib/format';

export function StatusChip({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Priority({ p }) {
  return <span className={`prio prio-${p}`} title={`Priority ${p}`}>P{p}</span>;
}

export default function ItemRow({ item, selected, onSelect, showTeam = true }) {
  return (
    <li className={`item-row p${item.priority} ${selected ? 'selected' : ''}`}>
      <button onClick={() => onSelect(item.id)} aria-current={selected ? 'true' : undefined}>
        <Priority p={item.priority} />
        <span className="key">{item.key}</span>
        <span className="title">{item.title}</span>
        <StatusChip status={item.status} />
        <span className="assignee">{item.assignee?.name || <em className="muted">Unassigned</em>}</span>
        <span className={`due ${item.overdue ? 'overdue' : ''}`} title={`Due ${absolute(item.dueAt)}`}>
          {dueLabel(item)}
        </span>
        {showTeam && <span className="team muted">{item.team.name}</span>}
      </button>
    </li>
  );
}
