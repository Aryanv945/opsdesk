import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { VIEWS } from '../lib/views';
import { STATUS_LABEL, TYPE_LABEL } from '../lib/format';
import { useLive } from '../lib/live';
import ItemRow from '../components/ItemRow';
import ItemDetail from '../components/ItemDetail';

const OVERRIDES = ['teamId', 'status', 'priority', 'type', 'assignee', 'q', 'sort'];
const csv = (v) => (v ? v.split(',') : undefined);

export default function Work({ me }) {
  const [params, setParams] = useSearchParams();
  const viewKey = VIEWS[params.get('view')] ? params.get('view') : 'all';
  const view = VIEWS[viewKey];
  const selected = params.get('item') ? Number(params.get('item')) : null;
  const { listChanges, resetListChanges } = useLive();

  const filters = useMemo(() => {
    const f = { ...view.filters };
    for (const k of OVERRIDES) {
      const v = params.get(k);
      if (v === null) continue;
      if (v === '') { delete f[k]; continue; }
      f[k] = ['status', 'priority', 'type'].includes(k) ? csv(v) : v;
    }
    return f;
  }, [params, view]);

  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get('/teams'), staleTime: 5 * 60_000 });

  const list = useInfiniteQuery({
    queryKey: ['items', 'list', filters],
    queryFn: ({ pageParam }) => api.get(`/items${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Lists refresh on the user's own actions or on request — not under their cursor.
    staleTime: Infinity,
  });

  useEffect(() => { resetListChanges(); }, [filters, resetListChanges]);

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total;

  // Infinite scroll
  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) next.delete(k); else next.set(k, v);
    }
    setParams(next, { replace: isSelectionOnly(changes) });
  };
  const select = (id) => update({ item: id == null ? undefined : String(id) });

  // j / k to move through the list, Escape to close the panel
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || e.metaKey || e.ctrlKey) return;
      if (document.querySelector('.modal')) return;
      if (e.key === 'Escape' && selected) select(null);
      if (e.key !== 'j' && e.key !== 'k') return;
      const idx = items.findIndex((i) => i.id === selected);
      const next = items[e.key === 'j' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)];
      if (next) select(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const filterValue = (k) => (params.get(k) ?? (Array.isArray(view.filters[k]) ? view.filters[k].join(',') : view.filters[k] ?? '')) || '';

  return (
    <div className={`work ${selected ? 'with-detail' : ''}`}>
      <section className="list-pane">
        <header className="list-head">
          <div>
            <h1 className="page-title">{view.label}</h1>
            <p className="muted">
              {filters.q ? <>Results for “{filters.q}” · </> : null}
              {total === undefined ? 'Loading…' : `${total.toLocaleString()} item${total === 1 ? '' : 's'}`}
            </p>
          </div>
        </header>

        <div className="filters" role="group" aria-label="Filters">
          <select aria-label="Team" value={filterValue('teamId')} onChange={(e) => update({ teamId: e.target.value })}>
            <option value="">All my teams</option>
            {teams.data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select aria-label="Status" value={filterValue('status')} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Any status</option>
            <option value="active">Active (not resolved)</option>
            <option value="open,blocked">Open or blocked</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Priority" value={filterValue('priority')} onChange={(e) => update({ priority: e.target.value })}>
            <option value="">Any priority</option>
            <option value="1,2">P1–P2</option>
            {[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}
          </select>
          <select aria-label="Assignee" value={filterValue('assignee')} onChange={(e) => update({ assignee: e.target.value })}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <select aria-label="Type" value={filterValue('type')} onChange={(e) => update({ type: e.target.value })}>
            <option value="">Any type</option>
            {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Sort" value={filterValue('sort') || 'updated'} onChange={(e) => update({ sort: e.target.value })}>
            <option value="updated">Sort: recently updated</option>
            <option value="priority">Sort: priority</option>
            <option value="due">Sort: due soonest</option>
            <option value="created">Sort: newest</option>
          </select>
          {OVERRIDES.some((k) => params.has(k)) && (
            <button className="btn ghost small" onClick={() => setParams({ view: viewKey })}>Reset filters</button>
          )}
        </div>

        {listChanges > 0 && (
          <button className="changes-banner" onClick={() => { list.refetch(); resetListChanges(); }}>
            {listChanges === 1 ? '1 change' : `${listChanges} changes`} by others since this list loaded. Refresh
          </button>
        )}

        {list.error && <p className="error pad">{list.error.message}</p>}
        {list.data && !items.length && (
          <div className="empty">
            <p>{filters.q ? 'No work items match this search in your teams.' : 'Nothing here right now.'}</p>
            {OVERRIDES.some((k) => params.has(k)) && <button className="btn" onClick={() => setParams({ view: viewKey })}>Clear filters</button>}
          </div>
        )}
        <ul className="rows">
          {items.map((i) => <ItemRow key={i.id} item={i} selected={i.id === selected} onSelect={select} />)}
        </ul>
        <div ref={sentinel} className="sentinel">
          {list.isFetchingNextPage ? 'Loading more…' : list.hasNextPage ? '' : items.length > 50 ? 'End of list' : ''}
        </div>
      </section>

      {selected && <ItemDetail key={selected} id={selected} me={me} onClose={() => select(null)} />}
    </div>
  );
}

function isSelectionOnly(changes) {
  return Object.keys(changes).length === 1 && 'item' in changes;
}
