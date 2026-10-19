import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { VIEWS, DASHBOARD_COUNTS } from '../lib/views';
import { STATUS_LABEL } from '../lib/format';
import ItemRow from '../components/ItemRow';

function Queue({ view, empty }) {
  const navigate = useNavigate();
  const { filters, label } = VIEWS[view];
  const { data, isPending, error } = useQuery({
    queryKey: ['items', 'preview', view],
    queryFn: () => api.get(`/items${qs({ ...filters, limit: 8 })}`),
  });
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{label}</h2>
        <Link to={`/work?view=${view}`}>{data?.total > 8 ? `See all ${data.total.toLocaleString()}` : 'Open view'}</Link>
      </header>
      {isPending && <p className="muted pad">Loading…</p>}
      {error && <p className="error pad">{error.message}</p>}
      {data && !data.items.length && <p className="muted pad">{empty}</p>}
      <ul className="rows compact">
        {data?.items.map((i) => <ItemRow key={i.id} item={i} onSelect={(id) => navigate(`/work?view=${view}&item=${id}`)} />)}
      </ul>
    </section>
  );
}

export default function Dashboard({ me }) {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const counts = data?.counts;
  const leads = me.isAdmin || me.memberships.some((m) => m.role === 'lead');
  const statuses = ['open', 'in_progress', 'blocked', 'awaiting_approval'];

  return (
    <div className="page">
      <h1 className="page-title">What needs attention</h1>
      <div className="signals">
        {DASHBOARD_COUNTS.filter(([v]) => v !== 'approvals' || leads).map(([view, key]) => (
          <Link key={view} to={`/work?view=${view}`} className={`signal ${counts?.[key] > 0 && ['overdue', 'unassigned'].includes(view) ? 'hot' : ''}`}>
            <span className="signal-n">{counts ? counts[key].toLocaleString() : '–'}</span>
            <span className="signal-l">{VIEWS[view].label}</span>
          </Link>
        ))}
      </div>

      <div className="grid2">
        <Queue view="unassigned" empty="Every urgent item has an owner." />
        <Queue view="mine" empty="Nothing assigned to you. Claim something from Unassigned urgent." />
        {leads && <Queue view="approvals" empty="No approvals waiting on you." />}
        <Queue view="overdue" empty="Nothing is overdue." />
      </div>

      {data?.teams?.length > 0 && (
        <section className="panel">
          <header className="panel-head"><h2>Active work by team</h2></header>
          <div className="table-wrap">
            <table className="load">
              <thead><tr><th>Team</th>{statuses.map((s) => <th key={s} className="num">{STATUS_LABEL[s]}</th>)}</tr></thead>
              <tbody>
                {data.teams.map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/work?view=all&teamId=${t.id}&status=active`}>{t.name}</Link></td>
                    {statuses.map((s) => (
                      <td key={s} className="num">
                        {t.counts[s] ? <Link to={`/work?view=all&teamId=${t.id}&status=${s}`}>{t.counts[s].toLocaleString()}</Link> : <span className="muted">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
