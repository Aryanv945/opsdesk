import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newKey } from '../lib/api';
import { useItemAction } from '../lib/useItemAction';
import { useToast } from '../lib/toast';
import { STATUS_LABEL, TYPE_LABEL, PRIORITY_LABEL, relative, absolute, toLocalInput } from '../lib/format';
import { StatusChip, Priority } from './ItemRow';
import Timeline from './Timeline';
import Modal from './Modal';

const FIELDS = ['title', 'description', 'priority', 'type', 'dueAt', 'requiresApproval'];
const FIELD_LABEL = { title: 'Title', description: 'Description', priority: 'Priority', type: 'Type', dueAt: 'Due', requiresApproval: 'Needs approval' };
const pickFields = (item) => Object.fromEntries(FIELDS.map((f) => [f, item[f]]));
const changedBetween = (a, b) => FIELDS.filter((f) => a[f] !== b[f]);
const show = (field, v) => field === 'priority' ? PRIORITY_LABEL[v] : field === 'type' ? TYPE_LABEL[v] : field === 'dueAt' ? absolute(v)
  : field === 'requiresApproval' ? (v ? 'Yes' : 'No') : field === 'description' ? (v ? `${v.slice(0, 80)}${v.length > 80 ? '…' : ''}` : '(empty)') : v;

export default function ItemDetail({ id, me, onClose }) {
  const q = useQuery({ queryKey: ['item', id], queryFn: () => api.get(`/items/${id}`), staleTime: 5_000 });
  const item = q.data?.item;
  const action = useItemAction(id);
  const toast = useToast();
  const [editing, setEditing] = useState(null); // { base, draft }
  const [conflict, setConflict] = useState(null);
  const [noteFor, setNoteFor] = useState(null);

  if (q.isPending) return <aside className="detail-pane"><p className="muted pad">Loading…</p></aside>;
  if (q.error) {
    return (
      <aside className="detail-pane">
        <div className="pad">
          <p className="error">{q.error.status === 404 ? 'This item doesn\'t exist or isn\'t in one of your teams.' : q.error.message}</p>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </aside>
    );
  }

  const p = item.permissions;
  const busy = action.isPending;
  const run = (path, body, optimistic, extra) => action.mutate({ path, body, optimistic, key: newKey(), ...extra });

  const claim = () => run('/claim', {}, (it) => ({
    ...it, assignee: { id: me.id, name: me.name }, status: it.status === 'open' ? 'in_progress' : it.status,
    permissions: { ...it.permissions, claim: false },
  }), {
    onError: (err) => {
      if (err.code !== 'ALREADY_CLAIMED') return false;
      toast(`${err.details.assignee.name} took this item just before you.`, 'warn');
      return true;
    },
    onSuccess: (d) => toast(d.alreadyOwned ? 'You already own this item.' : `You're now responsible for ${item.key}.`, 'success'),
  });

  const transition = (to, note) => run('/transition', { to, note, expectedVersion: item.version },
    (it) => ({ ...it, status: to, permissions: { ...it.permissions, transitions: [] } }),
    { onSuccess: () => toast(`${item.key} is now ${STATUS_LABEL[to].toLowerCase()}.`, 'success') });

  return (
    <aside className="detail-pane" aria-label={`${item.key} details`}>
      <header className="detail-head">
        <div className="detail-meta">
          <span className="key">{item.key}</span>
          <span className="muted">{TYPE_LABEL[item.type]} in {item.team.name}</span>
        </div>
        <button className="btn ghost small" onClick={onClose} aria-label="Close details">Close</button>
      </header>

      {editing ? (
        <Editor item={item} editing={editing} setEditing={setEditing} conflict={conflict} setConflict={setConflict} />
      ) : (
        <>
          <h2 className={`detail-title p${item.priority}`}>{item.title}</h2>
          <div className="facts">
            <Fact label="Status"><StatusChip status={item.status} /></Fact>
            <Fact label="Priority"><Priority p={item.priority} /> {PRIORITY_LABEL[item.priority].slice(3)}</Fact>
            <Fact label="Owner">{item.assignee?.name || <em className="muted">Nobody yet</em>}</Fact>
            <Fact label="Due"><span className={item.overdue ? 'overdue' : ''} title={absolute(item.dueAt)}>{relative(item.dueAt)}{item.overdue && ' (overdue)'}</span></Fact>
            <Fact label="Reported by">{item.reporter.name}, {relative(item.createdAt)}</Fact>
            <Fact label="Approval">
              {!item.requiresApproval ? 'Not required' : item.approvedBy ? `Approved by ${item.approvedBy.name}` : item.status === 'awaiting_approval' ? 'Waiting for a lead' : 'Required before resolving'}
            </Fact>
            {item.resolution && <Fact label="Resolution">{item.resolution}</Fact>}
          </div>

          <div className="detail-actions">
            {p.claim && <button className="btn primary" disabled={busy} onClick={claim}>Take this item</button>}
            {p.transitions.map((t) => (
              <button key={t.to} className={`btn ${t.label === 'Approve' || t.label === 'Resolve' ? 'primary' : ''}`} disabled={busy}
                onClick={() => (t.needsNote ? setNoteFor(t) : transition(t.to))}>{t.label}</button>
            ))}
            {p.edit && <button className="btn" disabled={busy} onClick={() => { setConflict(null); setEditing({ base: item, draft: pickFields(item) }); }}>Edit</button>}
            {p.release && (
              <button className="btn ghost" disabled={busy} onClick={() => run('/release', { expectedVersion: item.version },
                (it) => ({ ...it, assignee: null, status: 'open' }))}>{item.assignee?.id === me.id ? 'Give up item' : 'Unassign'}</button>
            )}
          </div>
          {p.assign && <AssignControl item={item} disabled={busy} onAssign={(assigneeId) => run('/assign', { assigneeId, expectedVersion: item.version })} />}
          {!p.edit && !p.claim && p.transitions.length === 0 && (
            <p className="muted small">{item.status === 'closed' ? 'Closed. A team lead can reopen it.' : 'You can follow and comment on this item, but not change it.'}</p>
          )}

          <section className="description">
            <h3>Description</h3>
            {item.description ? <p className="prewrap">{item.description}</p> : <p className="muted">No description.</p>}
          </section>
        </>
      )}

      <Timeline item={item} me={me} />

      {noteFor && (
        <NoteDialog transition={noteFor} onCancel={() => setNoteFor(null)}
          onSubmit={(note) => { setNoteFor(null); transition(noteFor.to, note); }} />
      )}
    </aside>
  );
}

function Fact({ label, children }) {
  return <div className="fact"><span className="fact-l">{label}</span><span className="fact-v">{children}</span></div>;
}

function AssignControl({ item, onAssign, disabled }) {
  const members = useQuery({
    queryKey: ['members', item.team.id], queryFn: () => api.get(`/teams/${item.team.id}/members`), staleTime: 5 * 60_000,
  });
  const assignable = members.data?.members.filter((m) => m.role !== 'viewer') ?? [];
  return (
    <label className="assign">
      <span>Assign to</span>
      <select value={item.assignee?.id ?? ''} disabled={disabled || members.isPending}
        onChange={(e) => onAssign(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Nobody</option>
        {assignable.map((m) => <option key={m.id} value={m.id}>{m.name}{m.role === 'lead' ? ' (lead)' : ''}</option>)}
      </select>
    </label>
  );
}

function NoteDialog({ transition, onCancel, onSubmit }) {
  const [note, setNote] = useState('');
  const prompts = {
    Reject: 'What needs to change before this can be approved?',
    'Mark blocked': 'What is this waiting on?',
    Reopen: 'Why is this being reopened?',
    Cancel: 'Why is this no longer needed?',
  };
  return (
    <Modal title={transition.label} onClose={onCancel} width="480px">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (note.trim()) onSubmit(note.trim()); }}>
        <label>{prompts[transition.label] || 'Add a note'}
          <textarea autoFocus rows={4} value={note} onChange={(e) => setNote(e.target.value)} required />
        </label>
        <p className="muted small">This note is saved to the item's history.</p>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
          <button className="btn primary" disabled={!note.trim()}>{transition.label}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Edit form with stale-data handling.
 *  - While editing, if someone else saves, a banner says who changed what.
 *  - On save, a 409 is resolved automatically when the other person's changes
 *    touch different fields (we re-apply only *our* changed fields on top).
 *  - When both changed the same field, the user decides, field by field.
 */
function Editor({ item, editing, setEditing, conflict, setConflict }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { base, draft } = editing;
  const mine = changedBetween(base, { ...base, ...draft });
  const theirs = item.version !== base.version ? changedBetween(pickFields(base), pickFields(item)) : [];
  const overlap = mine.filter((f) => theirs.includes(f));
  const set = (k, v) => setEditing((e) => ({ ...e, draft: { ...e.draft, [k]: v } }));

  const changedMeanwhile = item.version !== base.version;

  async function save(force = false) {
    if (!mine.length) { setEditing(null); return; }
    setSaving(true);
    setError(null);
    const changes = Object.fromEntries(mine.map((f) => [f, draft[f]]));
    const latest = qc.getQueryData(['item', item.id])?.item ?? item;
    // If we already know about newer non-overlapping changes, rebase silently.
    const expectedVersion = force || (theirs.length && !overlap.length) ? latest.version : base.version;
    try {
      const { item: saved } = await api.mutate('PATCH', `/items/${item.id}`, { expectedVersion, changes }, newKey());
      qc.setQueryData(['item', item.id], { item: saved });
      qc.invalidateQueries({ queryKey: ['activity', item.id] });
      qc.invalidateQueries({ queryKey: ['items'] });
      if (expectedVersion !== base.version) toast('Saved. Your edits were combined with changes someone made meanwhile.', 'success');
      else toast('Changes saved.', 'success');
      setConflict(null);
      setEditing(null);
    } catch (err) {
      if (err.code !== 'VERSION_CONFLICT') { setError(err.message); return; }
      const current = err.details.current;
      qc.setQueryData(['item', item.id], (old) => ({ item: { ...current, permissions: old?.item.permissions ?? current.permissions } }));
      const theirsNow = changedBetween(pickFields(base), pickFields(current));
      const clash = mine.filter((f) => theirsNow.includes(f));
      const who = [...new Set(err.details.changes.map((c) => c.actor))].join(', ');
      if (!clash.length) {
        // Different fields: safe to apply ours on top of theirs.
        setSaving(false);
        setEditing({ base: { ...base, version: current.version, ...Object.fromEntries(theirsNow.map((f) => [f, current[f]])) }, draft });
        return save(true);
      }
      setConflict({ who, clash, current });
    } finally {
      setSaving(false);
    }
  }

  const resolveField = (field, useMine) => {
    if (!useMine) set(field, conflict.current[field]);
    setConflict((c) => ({ ...c, clash: c.clash.filter((f) => f !== field) }));
  };

  return (
    <form className="editor stack" onSubmit={(e) => { e.preventDefault(); save(!!conflict); }}>
      {changedMeanwhile && !conflict && (
        <div className="notice warn" role="status">
          Someone saved changes to {theirs.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ') || 'this item'} while you were editing.
          {overlap.length ? ` You've also changed ${overlap.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ')}; you'll be asked which to keep.` : ' Your edits touch different fields and will be combined.'}
        </div>
      )}
      {conflict && conflict.clash.length > 0 && (
        <div className="notice conflict" role="alert">
          <p><strong>{conflict.who}</strong> changed the same fields you did. Choose which version to keep:</p>
          {conflict.clash.map((f) => (
            <div className="clash" key={f}>
              <span className="fact-l">{FIELD_LABEL[f]}</span>
              <button type="button" className="btn small" onClick={() => resolveField(f, false)}>Keep theirs: {show(f, conflict.current[f])}</button>
              <button type="button" className="btn small" onClick={() => resolveField(f, true)}>Keep mine: {show(f, draft[f])}</button>
            </div>
          ))}
        </div>
      )}
      <label>Title<input value={draft.title} onChange={(e) => set('title', e.target.value)} minLength={3} maxLength={200} required /></label>
      <div className="row3">
        <label>Priority
          <select value={draft.priority} onChange={(e) => set('priority', Number(e.target.value))}>{[1, 2, 3, 4].map((v) => <option key={v} value={v}>{PRIORITY_LABEL[v]}</option>)}</select>
        </label>
        <label>Type
          <select value={draft.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Due
          <input type="datetime-local" value={toLocalInput(draft.dueAt)} onChange={(e) => e.target.value && set('dueAt', new Date(e.target.value).getTime())} />
        </label>
      </div>
      {item.permissions.editApproval && (
        <label className="check"><input type="checkbox" checked={draft.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} /> Requires lead approval before resolving</label>
      )}
      <label>Description<textarea rows={8} value={draft.description} onChange={(e) => set('description', e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={() => { setConflict(null); setEditing(null); }}>Discard edits</button>
        <button className="btn primary" disabled={saving || (conflict && conflict.clash.length > 0)}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}
