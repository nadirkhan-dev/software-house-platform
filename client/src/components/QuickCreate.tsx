import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { Field, Modal } from './ui';
import type { Project } from '../lib/types';

/**
 * Quick create.
 *
 * A palette rather than a menu of links: pick a thing, fill the two or three
 * fields that actually matter, and land on it. Anything needing more than that
 * — a full quote with line items — opens its own screen instead of pretending
 * to be a small form.
 */

type Kind = 'lead' | 'task' | 'expense' | 'time' | null;

const OPTIONS: { kind: Exclude<Kind, null>; label: string; hint: string }[] = [
  { kind: 'lead', label: 'Lead', hint: 'Someone who might buy' },
  { kind: 'task', label: 'Task', hint: 'Work on a project' },
  { kind: 'time', label: 'Time entry', hint: 'Hours you worked' },
  { kind: 'expense', label: 'Expense', hint: 'Cost against a project' },
];

export function QuickCreate({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(null);

  if (!kind) {
    return (
      <Modal title="Create" meta="⌘K" onClose={onClose}>
        <div className="pad">
          {OPTIONS.map(o => (
            <button key={o.kind} className="qcrow" onClick={() => setKind(o.kind)}>
              <b>{o.label}</b><span>{o.hint}</span>
            </button>
          ))}
          <div className="hint" style={{ marginTop: 12 }}>
            Quotes need line items, so they open their own screen. Clients are
            created by converting a lead, which keeps the pipeline honest.
          </div>
        </div>
      </Modal>
    );
  }
  return <QuickForm kind={kind} onClose={onClose} onBack={() => setKind(null)} />;
}

function QuickForm({ kind, onClose, onBack }: { kind: Exclude<Kind, null>; onClose: () => void; onBack: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({
    incurred_on: new Date().toISOString().slice(0, 10),
    worked_on: new Date().toISOString().slice(0, 10),
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Project[] }>('/projects'),
    enabled: kind !== 'lead',
  });

  const set = (k: string) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: async () => {
      switch (kind) {
        case 'lead':
          return api<{ lead: { id: string } }>('/leads', {
            method: 'POST',
            body: { company: form.company, contact_name: form.contact_name || undefined,
                    email: form.email || undefined, est_value: form.est_value || 0 },
          });
        case 'task':
          return api('/tasks', {
            method: 'POST',
            body: { project_id: form.project_id, title: form.title,
                    priority: form.priority || 'medium',
                    estimate_hours: form.estimate_hours || undefined },
          });
        case 'time':
          return api('/time', {
            method: 'PUT',
            body: { project_id: form.project_id, worked_on: form.worked_on, hours: form.hours },
          });
        case 'expense':
          return api('/expenses', {
            method: 'POST',
            body: { project_id: form.project_id || undefined, incurred_on: form.incurred_on,
                    description: form.description, category: form.category || 'other',
                    amount: form.amount, currency: 'USD' },
          });
      }
    },
    onSuccess: () => {
      toast(`${kind === 'time' ? 'Time' : kind[0]!.toUpperCase() + kind.slice(1)} saved`);
      void qc.invalidateQueries();
      onClose();
      const dest = { lead: '/leads', task: '/tasks', time: '/time', expense: '/expenses' } as const;
      nav(dest[kind]);
    },
    onError: (e: ApiError) => {
      setFieldErrors(e.fields ?? {});
      toast(e.message, 'bad');
    },
  });

  const projectField = (
    <Field label="Project" error={fieldErrors.project_id}>
      <select value={form.project_id ?? ''} onChange={set('project_id')}>
        <option value="">Choose a project…</option>
        {projects?.projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
      </select>
    </Field>
  );

  return (
    <Modal title={`New ${kind}`} onClose={onClose}>
      <form className="pad" onSubmit={e => { e.preventDefault(); submit.mutate(); }}>
        {kind === 'lead' && <>
          <Field label="Company" error={fieldErrors.company}>
            <input value={form.company ?? ''} onChange={set('company')} required autoFocus /></Field>
          <Field label="Contact"><input value={form.contact_name ?? ''} onChange={set('contact_name')} /></Field>
          <Field label="Email" error={fieldErrors.email}>
            <input type="email" value={form.email ?? ''} onChange={set('email')} /></Field>
          <Field label="Estimated value (USD)">
            <input type="number" min="0" value={form.est_value ?? ''} onChange={set('est_value')} /></Field>
        </>}

        {kind === 'task' && <>
          {projectField}
          <Field label="Title" error={fieldErrors.title}>
            <input value={form.title ?? ''} onChange={set('title')} required /></Field>
          <Field label="Priority">
            <select value={form.priority ?? 'medium'} onChange={set('priority')}>
              <option value="low">Low</option><option value="medium">Medium</option>
              <option value="high">High</option><option value="urgent">Urgent</option>
            </select></Field>
          <Field label="Estimate (hours)">
            <input type="number" min="0" step="0.5" value={form.estimate_hours ?? ''} onChange={set('estimate_hours')} /></Field>
        </>}

        {kind === 'time' && <>
          {projectField}
          <Field label="Date"><input type="date" value={form.worked_on ?? ''} onChange={set('worked_on')} /></Field>
          <Field label="Hours" error={fieldErrors.hours}>
            <input type="number" min="0" max="24" step="0.5" value={form.hours ?? ''} onChange={set('hours')} required /></Field>
        </>}

        {kind === 'expense' && <>
          {projectField}
          <Field label="Description" error={fieldErrors.description}>
            <input value={form.description ?? ''} onChange={set('description')} required /></Field>
          <Field label="Category">
            <select value={form.category ?? 'other'} onChange={set('category')}>
              {['infrastructure','software','services','travel','hardware','other'].map(c =>
                <option key={c} value={c}>{c}</option>)}
            </select></Field>
          <Field label="Amount (USD)" error={fieldErrors.amount}>
            <input type="number" min="0" step="0.01" value={form.amount ?? ''} onChange={set('amount')} required /></Field>
          <Field label="Date"><input type="date" value={form.incurred_on ?? ''} onChange={set('incurred_on')} /></Field>
        </>}

        <div className="modal-act">
          <button type="button" className="btn" onClick={onBack}>Back</button>
          <button type="submit" className="btn pri" disabled={submit.isPending}>
            {submit.isPending ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
