import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api, newKey } from '../lib/api';
import { STATUS_LABEL, TYPE_LABEL, relative, absolute } from '../lib/format';

function describe(e) {
  const d = e.data;
  switch (e.kind) {
    case 'created': return 'created this item';
    case 'claimed': return 'took responsibility for this item';
    case 'released': return `released it${d.fromName ? ` from ${d.fromName}` : ''}`;
    case 'assigned': return d.to ? `assigned it to ${d.toName || 'someone'}` : `unassigned ${d.fromName || 'it'}`;
    case 'transitioned':
      if (d.from === 'awaiting_approval' && d.to === 'resolved') return 'approved and resolved it';
      if (d.from === 'awaiting_approval' && d.to === 'in_progress') return 'rejected the approval request';
      return `moved it from ${STATUS_LABEL[d.from]} to ${STATUS_LABEL[d.to]}`;
    case 'updated': {
      const parts = Object.entries(d.changes || {}).map(([f, c]) => {
        if (f === 'priority') return `priority P${c.from} → P${c.to}`;
        if (f === 'type') return `type ${TYPE_LABEL[c.from]} → ${TYPE_LABEL[c.to]}`;
        if (f === 'requiresApproval') return c.to ? 'now requires approval' : 'no longer requires approval';
        if (f === 'dueAt') return `due date to ${absolute(c.to)}`;
        if (f === 'title') return `title to “${c.to}”`;
        return f;
      });
      return `changed ${parts.join(', ')}`;
    }
    default: return e.kind;
  }
}

export default function Timeline({ item }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  // Comments appear instantly; each keeps its own idempotency key so "Retry" can't post it twice.
  const [pending, setPending] = useState([]);

  const q = useInfiniteQuery({
    queryKey: ['activity', item.id],
    queryFn: ({ pageParam }) => api.get(`/items/${item.id}/activity${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];

  async function send(comment) {
    setPending((list) => list.map((c) => (c.key === comment.key ? { ...c, failed: false } : c)));
    try {
      await api.mutate('POST', `/items/${item.id}/comments`, { body: comment.body }, comment.key);
      await qc.invalidateQueries({ queryKey: ['activity', item.id] });
      setPending((list) => list.filter((c) => c.key !== comment.key));
    } catch (err) {
      setPending((list) => list.map((c) => (c.key === comment.key ? { ...c, failed: err.message } : c)));
    }
  }

  function submit(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    const comment = { key: newKey(), body: text, at: Date.now() };
    setPending((list) => [comment, ...list]);
    setBody('');
    send(comment);
  }

  return (
    <section className="timeline">
      <h3>History and discussion</h3>
      {item.permissions.comment && (
        <form onSubmit={submit} className="comment-form">
          <textarea rows={2} placeholder="Add an update or question" value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }} aria-label="Comment" />
          <button className="btn" disabled={!body.trim()}>Comment</button>
        </form>
      )}
      <ol>
        {pending.map((c) => (
          <li key={c.key} className={`entry comment ${c.failed ? 'failed' : 'sending'}`}>
            <div className="entry-head"><strong>You</strong> <span className="muted">{c.failed ? 'not sent' : 'sending…'}</span></div>
            <p className="prewrap">{c.body}</p>
            {c.failed && (
              <p className="error small">{c.failed} <button className="link" onClick={() => send(c)}>Retry</button>
                {' '}<button className="link" onClick={() => setPending((l) => l.filter((x) => x.key !== c.key))}>Discard</button></p>
            )}
          </li>
        ))}
        {entries.map((e) => (
          <li key={e.id} className={`entry ${e.kind === 'commented' ? 'comment' : 'event'}`}>
            <div className="entry-head">
              <strong>{e.actor.name}</strong> {e.kind !== 'commented' && <span>{describe(e)}</span>}
              <time className="muted" title={absolute(e.createdAt)}>{relative(e.createdAt)}</time>
            </div>
            {e.kind === 'commented' && <p className="prewrap">{e.data.body}</p>}
            {e.kind === 'transitioned' && e.data.note && <p className="note">{e.data.note}</p>}
          </li>
        ))}
      </ol>
      {q.hasNextPage && <button className="btn ghost small" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Show earlier history</button>}
    </section>
  );
}
