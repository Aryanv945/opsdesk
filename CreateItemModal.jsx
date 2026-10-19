import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, newKey } from '../lib/api';
import { useToast } from '../lib/toast';
import { TYPE_LABEL, PRIORITY_LABEL } from '../lib/format';
import Modal from './Modal';

const APPROVAL_TYPES = new Set(['payment', 'compliance']);

export default function CreateItemModal({ me, teams, onClose }) {
  const writable = useMemo(() => teams.filter((t) => t.role === 'member' || t.role === 'lead'), [teams]);
  const [form, setForm] = useState({
    teamId: '', title: '', description: '', type: 'task', priority: 3, assignToMe: false, requiresApproval: null,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // One key for this form's lifetime: double-clicks and network retries create one item.
  const key = useRef(newKey());
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  // Teams may still be loading when the modal opens, so fall back to the first writable team at render time.
  const teamId = Number(form.teamId) || writable[0]?.id;
  const team = writable.find((t) => t.id === teamId);
  const isLead = team?.role === 'lead';
  const approval = form.requiresApproval ?? APPROVAL_TYPES.has(form.type);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        teamId, title: form.title.trim(), description: form.description, type: form.type,
        priority: Number(form.priority), ...(form.assignToMe ? { assigneeId: me.id } : {}),
        ...(isLead && form.requiresApproval !== null ? { requiresApproval: form.requiresApproval } : {}),
      };
      const { item } = await api.mutate('POST', '/items', body, key.current);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(`Created ${item.key}`, 'success');
      onClose();
      navigate(`/work?view=all&item=${item.id}`);
    } catch (err) {
      setError(err.details?.length ? err.details.map((d) => `${d.path}: ${d.message}`).join('. ') : err.message);
      // A validation error means the request changed meaning; use a fresh key for the corrected attempt.
      if (err.status === 400 || err.status === 422) key.current = newKey();
    } finally {
      setBusy(false);
    }
  }

  if (!writable.length) {
    return <Modal title="New work item" onClose={onClose}><p>You have view-only access, so you can't create work items. Ask a team lead to add you as a member.</p></Modal>;
  }

  return (
    <Modal title="New work item" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Title
          <input autoFocus value={form.title} onChange={set('title')} minLength={3} maxLength={200} required placeholder="What needs investigating or doing?" />
        </label>
        <div className="row3">
          <label>Team
            <select value={teamId ?? ''} onChange={set('teamId')}>{writable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <label>Type
            <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, requiresApproval: null }))}>
              {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Priority
            <select value={form.priority} onChange={set('priority')}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select>
          </label>
        </div>
        <label>Description
          <textarea rows={5} value={form.description} onChange={set('description')} placeholder="Context, links, who raised it, what you've already checked" />
        </label>
        <label className="check"><input type="checkbox" checked={form.assignToMe} onChange={set('assignToMe')} /> Assign to me and start work</label>
        <label className="check">
          <input type="checkbox" checked={approval} disabled={!isLead} onChange={(e) => setForm((f) => ({ ...f, requiresApproval: e.target.checked }))} />
          Requires lead approval before it can be resolved
          {!isLead && <span className="muted"> (set by type; leads can change it)</span>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create work item'}</button>
        </div>
      </form>
    </Modal>
  );
}
