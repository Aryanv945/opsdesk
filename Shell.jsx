import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { VIEWS } from '../lib/views';
import { relative } from '../lib/format';
import CreateItemModal from './CreateItemModal';

export default function Shell({ me, children }) {
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const [params] = useSearchParams();
  const activeView = location.pathname === '/work' ? params.get('view') || 'all' : null;
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get('/teams'), staleTime: 5 * 60_000 });
  const counts = dash.data?.counts || {};
  const countFor = { mine: counts.mine, unassigned: counts.unassignedUrgent, approvals: counts.awaitingMyApproval, overdue: counts.overdue, blocked: counts.blocked };
  const canCreate = me.isAdmin || me.memberships.some((m) => m.role !== 'viewer');

  useEffect(() => setNavOpen(false), [location]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && canCreate) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCreate]);

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="wordmark">OpsDesk</span>
        </div>
        {canCreate && (
          <button className="btn primary block" onClick={() => setCreating(true)} title="Shortcut: C">New work item</button>
        )}
        <nav aria-label="Views">
          <NavLink to="/" end className="nav-item">Overview</NavLink>
          <div className="nav-group">Views</div>
          {Object.entries(VIEWS).map(([key, v]) => (
            <NavLink key={key} to={`/work?view=${key}`} className={() => `nav-item ${activeView === key ? 'active' : ''}`}>
              <span>{v.label}</span>
              {countFor[key] > 0 && <span className={`count ${key === 'overdue' || key === 'unassigned' ? 'hot' : ''}`}>{countFor[key].toLocaleString()}</span>}
            </NavLink>
          ))}
          {teams.data?.teams?.length > 0 && <div className="nav-group">Teams</div>}
          {teams.data?.teams?.map((t) => (
            <NavLink key={t.id} to={`/work?view=all&teamId=${t.id}`} className={() => `nav-item ${activeView === 'all' && params.get('teamId') === String(t.id) ? 'active' : ''}`}>
              <span>{t.name}</span><span className="role">{t.role}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <Topbar me={me} onMenu={() => setNavOpen((o) => !o)} />
        {children}
      </div>
      {creating && <CreateItemModal me={me} teams={teams.data?.teams || []} onClose={() => setCreating(false)} />}
    </div>
  );
}

function Topbar({ me, onMenu }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [q, setQ] = useState(location.pathname === '/work' ? params.get('q') || '' : '');
  const { status } = useLive();
  const qc = useQueryClient();

  useEffect(() => { if (location.pathname === '/work') setQ(params.get('q') || ''); }, [params, location.pathname]);

  function search(e) {
    e.preventDefault();
    const next = new URLSearchParams(location.pathname === '/work' ? params : { view: 'all' });
    if (q.trim()) next.set('q', q.trim()); else next.delete('q');
    next.delete('item');
    navigate(`/work?${next}`);
  }

  async function logout() {
    await api.logout().catch(() => {});
    qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], null);
  }

  return (
    <header className="topbar">
      <button className="btn ghost menu-btn" onClick={onMenu} aria-label="Toggle navigation">☰</button>
      <form className="search" onSubmit={search} role="search">
        <input type="search" placeholder="Search titles and descriptions, or jump to PAY-123" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work items" />
      </form>
      <span className={`live live-${status}`} title={status === 'live' ? 'Receiving live updates' : 'Reconnecting to live updates…'}>
        {status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Reconnecting'}
      </span>
      <Notifications />
      <div className="me">
        <span>{me.name}</span>
        <button className="btn ghost small" onClick={logout}>Sign out</button>
      </div>
    </header>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 60_000 });

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data?.unread) {
      await api.mutate('POST', '/notifications/read').catch(() => {});
      qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  }

  return (
    <div className="notif" ref={ref}>
      <button className="btn ghost" onClick={toggle} aria-expanded={open} aria-label={`Notifications, ${data?.unread || 0} unread`}>
        Inbox{data?.unread > 0 && <span className="badge">{data.unread}</span>}
      </button>
      {open && (
        <div className="popover">
          {!data?.notifications?.length && <p className="muted pad">Nothing yet. You'll hear about changes to work you reported, own or commented on.</p>}
          <ul>
            {data?.notifications?.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'}>
                <button onClick={() => { setOpen(false); navigate(`/work?view=all&item=${n.itemId}`); }}>
                  <span>{n.message}</span>
                  <time className="muted">{relative(n.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
