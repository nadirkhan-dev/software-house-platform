import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, Confirm, ErrorState, Field, Modal, Skeleton, Table } from '../components/ui';
import { useToast } from '../lib/toast';
import { dayLabel } from '../lib/format';

interface Company {
  name: string; legal_name: string | null; address: string | null; tax_id: string | null;
  email: string | null; phone: string | null; website: string | null;
  home_currency: string; base_currency: string; plan: string; seats_included: number;
  invoice_prefix: string; quote_prefix: string; next_invoice_no: number;
  default_tax_rate: number; default_tax_label: string | null;
  payment_terms_days: number; payment_instructions: string | null; invoice_footer: string | null;
}
interface Member {
  id: string; full_name: string; email: string; role: string; employment: string;
  weekly_hours: number; is_active: boolean; last_seen_at: string | null; client_name: string | null;
}
interface Integrations {
  asana: { configured: boolean; connected: boolean; reason?: string; account_name?: string;
           workspace_name?: string; last_sync_at?: string; last_error?: string;
           linked?: Record<string, number>; connected_by?: string };
  email: { configured: boolean; ok?: boolean; error?: string };
  storage: { driver: string; maxBytes: number };
}

const ROLES = ['admin', 'finance', 'sales', 'pm', 'lead', 'developer', 'designer', 'qa'] as const;

export function Settings() {
  const { user, perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'company' | 'team' | 'integrations'>('company');
  const [inviting, setInviting] = useState(false);
  const [confirmMember, setConfirmMember] = useState<Member | null>(null);

  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<{ company: Company; team: Member[] }>('/settings') });
  const integrations = useQuery({
    queryKey: ['integrations'], queryFn: () => api<Integrations>('/integrations'),
    enabled: tab === 'integrations',
  });

  const [form, setForm] = useState<Partial<Company>>({});
  useEffect(() => { if (s.data) setForm({}); }, [s.data]);

  const save = useMutation({
    mutationFn: (body: Partial<Company>) => api('/settings', { method: 'PATCH', body }),
    onSuccess: () => { toast('Saved'); setForm({}); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  const updateMember = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; is_active?: boolean }) =>
      api(`/settings/team/${id}`, { method: 'PATCH', body }),
    onSuccess: () => { toast('Updated'); setConfirmMember(null); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e: ApiError) => { toast(e.message, 'bad'); setConfirmMember(null); },
  });

  if (s.error) return <ErrorState error={s.error as Error} />;
  const readOnly = !perms?.canManageTeam;
  const c = s.data?.company;
  const value = <K extends keyof Company>(k: K): Company[K] | undefined =>
    (k in form ? form[k] : c?.[k]) as Company[K] | undefined;
  const set = (k: keyof Company) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <div className="head"><div>
        <div className="eyebrow">Workspace</div><h1>Settings</h1>
        <div className="sub">{readOnly ? 'You can view these; an admin can change them.' : 'Company details appear on every PDF you send.'}</div>
      </div></div>

      <div className="tabs">
        {(['company', 'team', 'integrations'] as const).map(t => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'company' ? 'Company' : t === 'team' ? 'Users and roles' : 'Integrations'}
          </button>
        ))}
      </div>

      {tab === 'company' && (s.isLoading ? <Card><Skeleton /></Card> : (
        <div className="split">
          <Card title="Company">
            <form className="pad" onSubmit={e => { e.preventDefault(); save.mutate(form); }}>
              <Field label="Trading name"><input value={value('name') ?? ''} onChange={set('name')} disabled={readOnly} /></Field>
              <Field label="Legal name"><input value={value('legal_name') ?? ''} onChange={set('legal_name')} disabled={readOnly} /></Field>
              <Field label="Address"><textarea rows={3} value={value('address') ?? ''}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))} disabled={readOnly} /></Field>
              <Field label="Tax ID"><input value={value('tax_id') ?? ''} onChange={set('tax_id')} disabled={readOnly} /></Field>
              <Field label="Billing email"><input type="email" value={value('email') ?? ''} onChange={set('email')} disabled={readOnly} /></Field>
              {!readOnly && <button className="btn pri" disabled={!Object.keys(form).length || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save company'}</button>}
            </form>
          </Card>

          <Card title="Invoicing">
            <form className="pad" onSubmit={e => { e.preventDefault(); save.mutate(form); }}>
              <Field label="Invoice prefix"><input value={value('invoice_prefix') ?? ''} onChange={set('invoice_prefix')} disabled={readOnly} /></Field>
              <Field label="Quote prefix"><input value={value('quote_prefix') ?? ''} onChange={set('quote_prefix')} disabled={readOnly} /></Field>
              <Field label="Default tax rate">
                <input type="number" step="0.001" min="0" max="1" value={value('default_tax_rate') ?? 0}
                  onChange={set('default_tax_rate')} disabled={readOnly} /></Field>
              <Field label="Tax label"><input value={value('default_tax_label') ?? ''} onChange={set('default_tax_label')}
                placeholder="e.g. SRB 15%" disabled={readOnly} /></Field>
              <Field label="Payment terms (days)">
                <input type="number" min="0" max="365" value={value('payment_terms_days') ?? 30}
                  onChange={set('payment_terms_days')} disabled={readOnly} /></Field>
              <Field label="Payment instructions"><textarea rows={3} value={value('payment_instructions') ?? ''}
                onChange={e => setForm(f => ({ ...f, payment_instructions: e.target.value }))} disabled={readOnly} /></Field>
              <div className="hint">Next invoice number: {c?.invoice_prefix}{String(c?.next_invoice_no).padStart(4, '0')}</div>
              {!readOnly && <button className="btn pri" style={{ marginTop: 14 }}
                disabled={!Object.keys(form).length || save.isPending}>Save invoicing</button>}
            </form>
          </Card>
        </div>
      ))}

      {tab === 'team' && (
        <Card title="Users and roles" meta={s.data ? `${s.data.team.filter(m => m.is_active).length} active` : undefined}>
          {!readOnly && (
            <div className="pad" style={{ borderBottom: '1px solid var(--rule)' }}>
              <button className="btn pri" onClick={() => setInviting(true)}>Invite someone</button>
            </div>
          )}
          {s.isLoading ? <Skeleton /> : (
            <Table head={<tr><th>Person</th><th>Role</th><th>Last seen</th><th /></tr>}>
              {s.data!.team.map(m => (
                <tr key={m.id} className={m.is_active ? '' : 'dim'}>
                  <td><div className="pname">{m.full_name}</div><div className="pclient">{m.email}</div></td>
                  <td>
                    {readOnly || m.role === 'client' ? <span className="chip flat">{m.role}</span> : (
                      <select className="inline" value={m.role}
                        onChange={e => updateMember.mutate({ id: m.id, role: e.target.value })}>
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                    {m.client_name && <div className="pclient">{m.client_name}</div>}
                  </td>
                  <td className="num">{m.last_seen_at ? dayLabel(m.last_seen_at) : 'never'}</td>
                  <td className="r">
                    {!readOnly && m.id !== user?.id && (
                      <button className="btn tiny" onClick={() => setConfirmMember(m)}>
                        {m.is_active ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'integrations' && <IntegrationsPanel data={integrations.data} loading={integrations.isLoading} />}

      {inviting && <InviteModal onClose={() => setInviting(false)} />}
      {confirmMember && (
        <Confirm title={confirmMember.is_active ? 'Disable this account?' : 'Enable this account?'}
          danger={confirmMember.is_active}
          confirmLabel={confirmMember.is_active ? 'Disable' : 'Enable'}
          body={confirmMember.is_active
            ? <><b>{confirmMember.full_name}</b> will not be able to sign in. Their logged time and
                approvals stay exactly as they are.</>
            : <><b>{confirmMember.full_name}</b> will be able to sign in again.</>}
          onConfirm={() => updateMember.mutate({ id: confirmMember.id, is_active: !confirmMember.is_active })}
          onClose={() => setConfirmMember(null)} />
      )}
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', full_name: '', role: 'developer', cost_amount: '', bill_rate: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const invite = useMutation({
    mutationFn: () => api<{ member: { needs_password: boolean } }>('/settings/team', {
      method: 'POST',
      body: { email: f.email, full_name: f.full_name, role: f.role,
              cost_amount: f.cost_amount || 0, bill_rate: f.bill_rate || 0 },
    }),
    onSuccess: r => {
      toast(r.member.needs_password
        ? 'Added. They need a password set before they can sign in.'
        : 'Added to your team.');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      onClose();
    },
    onError: (e: ApiError) => { setErrors(e.fields ?? {}); toast(e.message, 'bad'); },
  });

  return (
    <Modal title="Invite someone" onClose={onClose}>
      <form className="pad" onSubmit={e => { e.preventDefault(); invite.mutate(); }}>
        <Field label="Name" error={errors.full_name}>
          <input value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} required autoFocus /></Field>
        <Field label="Email" error={errors.email}>
          <input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Role">
          <select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select></Field>
        <Field label="Monthly cost (home currency)">
          <input type="number" min="0" value={f.cost_amount} onChange={e => setF({ ...f, cost_amount: e.target.value })} /></Field>
        <Field label="Bill rate per hour">
          <input type="number" min="0" value={f.bill_rate} onChange={e => setF({ ...f, bill_rate: e.target.value })} /></Field>
        <div className="hint">A rate card is created straight away — without one their first
          time entry would be rejected.</div>
        <div className="modal-act">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={invite.isPending}>{invite.isPending ? 'Adding…' : 'Add to team'}</button>
        </div>
      </form>
    </Modal>
  );
}

function IntegrationsPanel({ data, loading }: { data?: Integrations; loading: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { perms } = useSession();

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>('/integrations/asana/connect'),
    onSuccess: r => { window.location.href = r.url; },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });
  const disconnect = useMutation({
    mutationFn: () => api('/integrations/asana/disconnect', { method: 'POST' }),
    onSuccess: () => { toast('Asana disconnected'); void qc.invalidateQueries({ queryKey: ['integrations'] }); },
  });

  if (loading || !data) return <Card><Skeleton rows={4} /></Card>;
  const a = data.asana;

  return (
    <div className="split">
      <Card title="Asana" meta={a.connected ? 'connected' : a.configured ? 'not connected' : 'unavailable'}>
        <div className="pad">
          {!a.configured ? (
            <>
              <p className="sub" style={{ marginTop: 0 }}>{a.reason}</p>
              <div className="hint">
                An Asana admin creates an OAuth app at app.asana.com/0/my-apps and gives you a
                client id and secret. Those go in the server environment — never in the browser —
                as ASANA_CLIENT_ID and ASANA_CLIENT_SECRET.
              </div>
            </>
          ) : a.connected ? (
            <>
              <dl className="kv">
                <dt>Account</dt><dd>{a.account_name}</dd>
                <dt>Workspace</dt><dd>{a.workspace_name ?? '—'}</dd>
                <dt>Connected by</dt><dd>{a.connected_by ?? '—'}</dd>
                <dt>Last sync</dt><dd>{a.last_sync_at ? dayLabel(a.last_sync_at) : 'never'}</dd>
                <dt>Linked</dt><dd>{a.linked?.task ?? 0} tasks</dd>
              </dl>
              {a.last_error && <div className="err" style={{ marginTop: 12 }}>{a.last_error}</div>}
              {perms?.canManageTeam && (
                <button className="btn" style={{ marginTop: 16 }} onClick={() => disconnect.mutate()}>
                  Disconnect
                </button>
              )}
            </>
          ) : (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Import tasks from an Asana project and keep their status in step.
              </p>
              {perms?.canManageTeam
                ? <button className="btn pri" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    Connect Asana</button>
                : <div className="hint">An admin can connect this.</div>}
            </>
          )}
        </div>
      </Card>

      <div className="grid">
        <Card title="Email">
          <div className="pad">
            <dl className="kv">
              <dt>Status</dt><dd>{data.email.configured ? (data.email.ok ? 'connected' : 'configured') : 'not configured'}</dd>
            </dl>
            <div className="hint" style={{ marginTop: 10 }}>
              {data.email.configured
                ? data.email.error ?? 'Notifications are emailed as well as shown in the app.'
                : 'Set SMTP_URL on the server to email notifications. Until then they appear in-app only.'}
            </div>
          </div>
        </Card>
        <Card title="Storage">
          <div className="pad">
            <dl className="kv">
              <dt>Driver</dt><dd>{data.storage.driver}</dd>
              <dt>Max upload</dt><dd>{Math.round(data.storage.maxBytes / 1048576)} MB</dd>
            </dl>
          </div>
        </Card>
      </div>
    </div>
  );
}
