import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, Chip, Confirm, Empty, ErrorState, Field, Health, Modal, Money, Redacted, Skeleton, Table } from '../components/ui';
import { LedgerBar } from '../components/LedgerBar';
import { Calendar } from '../components/Calendar';
import { useToast } from '../lib/toast';
import { dayLabel, daysTo, has, hrs, label, pct, pkr, usd, usdK } from '../lib/format';
import type { Expense, Invoice, Lead, Milestone, Project, Quote, Task } from '../lib/types';

/* ------------------------------------------------------------- projects */

export function Projects() {
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects') });
  if (q.error) return <ErrorState error={q.error as Error} />;
  return (
    <>
      <div className="head"><div><div className="eyebrow">Delivery</div><h1>Projects</h1>
        <div className="sub">{q.data ? `${q.data.projects.length} visible to you` : ' '}</div></div></div>
      <Card>
        {q.isLoading ? <Skeleton /> : (
          <Table head={<tr><th>Project</th><th>Type</th><th className="r">Contract</th>
            <th className="r ledgerline">Cost</th><th className="r">Margin now</th>
            <th className="r">Projected</th><th style={{ width: 155 }}>Burn vs. delivery</th><th /></tr>}>
            {q.data!.projects.map(p => (
              <tr key={p.project_id}>
                <td><Link to={`/projects/${p.project_id}`} className="pname link">{p.name}</Link>
                  <div className="pclient">{p.client_name}</div></td>
                <td><Chip>{p.billing_type}</Chip></td>
                <td className="r num"><Money value={p.contract_value} fmt={usd} /></td>
                <td className="r num ledgerline" style={{ color: 'var(--cost)' }}><Money value={p.cost_base} fmt={usd} /></td>
                <td className="r num"><Money value={p.marginPct} fmt={pct} /></td>
                <td className="r num"><Money value={p.projMargin} fmt={pct} /></td>
                <td>
                  <div className="mini"><i style={{ width: `${Math.min(100, (p.burn ?? p.progress) * 100)}%`,
                    background: has(p.burn) && p.burn! > p.progress + 0.15 ? 'var(--cost)' : 'var(--rev)' }} /></div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {has(p.burn) ? `${pct(p.burn!)} burned · ` : ''}{pct(p.progress)} done</div>
                </td>
                <td className="r"><Health value={p.health} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

/* -------------------------------------------------------- project detail */

interface Detail {
  project: Project; milestones: Milestone[];
  changeOrders: { id: string; title: string; est_hours: number; price_amount: number; status: string; created_at: string }[];
  invoices: { id: string; number: string; total: number; balance: number; status: string; issued_on: string }[];
  breakdown: { full_name: string; role: string; hours: number; cost: number; value: number }[];
  fxRange: { lo: number; hi: number; days: number } | null;
}

export function ProjectDetail() {
  const { id } = useParams();
  const { perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api<Detail>(`/projects/${id}`) });

  const approve = useMutation({
    mutationFn: (mid: string) => api(`/milestones/${mid}/approve`, { method: 'POST' }),
    onSuccess: () => { toast('Signed off — now invoiceable'); void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;
  if (q.isLoading) return <Card><Skeleton rows={6} /></Card>;
  const d = q.data!, p = d.project;

  return (
    <>
      <Link to="/projects" className="back">← All projects</Link>
      <div className="head">
        <div><div className="eyebrow">{p.client_name} · {p.billing_type}</div>
          <h1>{p.name}</h1>
          <div className="sub">Started {dayLabel(p.starts_on)} · due {dayLabel(p.due_on)}</div></div>
        <Health value={p.health} />
      </div>

      <Card className="mb"><div className="pad">
        <LedgerBar project={p} big />
        <div className="lkey">
          {has(p.cost_base) && <>
            <span><i style={{ background: 'var(--cost)' }} />Cost {usd(p.cost_base!)} · {pkr(p.cost_home!)}</span>
            <span><i style={{ background: 'var(--rev)' }} />Margin {usd(p.contract_value! - p.cost_base!)}</span>
          </>}
          <span><i style={{ background: 'var(--ink)', width: 2, height: 10 }} />{pct(p.progress)} signed off</span>
        </div>
      </div></Card>

      <div className="split">
        <div className="grid">
          {!!d.breakdown.length && (
            <Card title="Where the money went" meta={`${Math.round(p.hours)} hours`}>
              <Table head={<tr><th>Person</th><th className="r">Hours</th>
                <th className="r ledgerline">Cost</th><th className="r">Billed</th><th className="r">Spread</th></tr>}>
                {d.breakdown.map(b => (
                  <tr key={b.full_name}>
                    <td>{b.full_name}<div className="pclient">{b.role}</div></td>
                    <td className="r num">{hrs(b.hours)}</td>
                    <td className="r num ledgerline" style={{ color: 'var(--cost)' }}>{usd(b.cost)}</td>
                    <td className="r num" style={{ color: 'var(--rev)' }}>{usd(b.value)}</td>
                    <td className="r num">{b.value > 0 ? `${(b.value / b.cost).toFixed(1)}×` : '—'}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
          <Card title="Change orders" meta={`${d.changeOrders.filter(c => c.status === 'absorbed').length} absorbed`}>
            {d.changeOrders.length ? (
              <Table head={<tr><th>Request</th><th className="r">Hours</th><th className="r">Billed</th><th className="r">Status</th></tr>}>
                {d.changeOrders.map(c => (
                  <tr key={c.id}>
                    <td>{c.title}<div className="pclient">raised {dayLabel(c.created_at)}</div></td>
                    <td className="r num">{c.est_hours}h</td>
                    <td className="r num">{c.price_amount ? usd(c.price_amount) : <span style={{ color: 'var(--cost)' }}>$0</span>}</td>
                    <td className="r"><Chip tone={c.status === 'approved' ? 'good' : c.status === 'sent' ? 'warn' : 'bad'}>{c.status}</Chip></td>
                  </tr>
                ))}
              </Table>
            ) : <Empty title="No scope changes logged.">Log every client request here, priced, before the work starts.</Empty>}
          </Card>
        </div>

        <div className="grid">
          <Card title="Commercials"><div className="pad">
            <dl className="kv">
              <dt>Contract</dt><dd><Money value={p.contract_value} fmt={usd} /></dd>
              <dt>Billing</dt><dd>{p.billing_type}</dd>
              <dt>Target</dt><dd><Money value={p.target_margin} fmt={pct} /></dd>
              <dt>Projected</dt><dd><Money value={p.projMargin} fmt={pct} /></dd>
              <dt>Eff. rate</dt><dd><Money value={p.effective_rate} fmt={usd} /> / hour</dd>
              {d.fxRange && <><dt>FX range</dt><dd>{Number(d.fxRange.lo).toFixed(2)} – {Number(d.fxRange.hi).toFixed(2)}</dd></>}
            </dl>
            {d.fxRange && <div className="hint">Costs here were converted at {d.fxRange.days} separate daily
              rates. That is why the rate is stored on each entry.</div>}
          </div></Card>

          <Card title="Milestones"><div className="pad">
            {d.milestones.map(m => (
              <div key={m.id} className={`ms ${m.approved_at ? 'done' : ''}`}>
                <div className="box">{m.approved_at ? '✓' : ''}</div>
                <div style={{ flex: 1 }}>{m.name}</div>
                {m.approved_at
                  ? <Chip tone="good">signed off</Chip>
                  : perms?.canApproveMilestone
                    ? <button className="btn tiny" disabled={approve.isPending}
                        onClick={() => approve.mutate(m.id)}>Approve</button>
                    : <Chip>awaiting sign-off</Chip>}
              </div>
            ))}
          </div></Card>

          <Card title="Invoices">
            {d.invoices.length ? (
              <Table head={<tr><th>Number</th><th className="r">Total</th><th className="r">Status</th></tr>}>
                {d.invoices.map(i => (
                  <tr key={i.id}><td className="num">{i.number}</td>
                    <td className="r num">{usd(i.total)}</td>
                    <td className="r"><Chip tone={i.status === 'paid' ? 'good' : 'warn'}>{label(i.status)}</Chip></td></tr>
                ))}
              </Table>
            ) : <Empty title="Nothing invoiced yet." />}
          </Card>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- leads */

const STAGES = [['new', 'New'], ['qualified', 'Qualified'], ['proposal', 'Proposal'],
  ['negotiation', 'Negotiation'], ['won', 'Won'], ['lost', 'Lost']] as const;
const NEXT: Record<string, string> = { new: 'qualified', qualified: 'proposal', proposal: 'negotiation', negotiation: 'won' };

export function Leads() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['leads'], queryFn: () => api<{ leads: Lead[] }>('/leads') });

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) => api(`/leads/${id}`, { method: 'PATCH', body: { stage } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['leads'] }),
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });
  const convert = useMutation({
    mutationFn: (id: string) => api<{ client: { name: string } }>(`/leads/${id}/convert`, { method: 'POST' }),
    onSuccess: r => { toast(`${r.client.name} is now a client — quote the work next`); void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;
  const leads = q.data?.leads ?? [];
  const open = leads.filter(l => !['won', 'lost'].includes(l.stage));

  return (
    <>
      <div className="head"><div><div className="eyebrow">Sales</div><h1>Pipeline</h1>
        <div className="sub">{open.length} open · {usd(open.reduce((s, l) => s + Number(l.est_value), 0))} in play
          · {usd(open.reduce((s, l) => s + Number(l.est_value) * l.probability / 100, 0))} weighted</div></div></div>
      {q.isLoading ? <Card><Skeleton /></Card> : (
        <div className="kanban">
          {STAGES.map(([key, name]) => {
            const col = leads.filter(l => l.stage === key);
            return (
              <div key={key} className="kcol">
                <div className="khead"><span>{name}</span>
                  <em>{col.length}{col.length ? ` · ${usdK(col.reduce((s, l) => s + Number(l.est_value), 0))}` : ''}</em></div>
                {col.length ? col.map(l => (
                  <div key={l.id} className="kcard">
                    <div className="kname">{l.company}</div>
                    <div className="kmeta">{l.contact_name ?? '—'}</div>
                    <div className="krow"><span className="num">{usdK(l.est_value)}</span><Chip>{l.probability}%</Chip></div>
                    {l.next_follow_up && <div className="kmeta">follow up {dayLabel(l.next_follow_up)}</div>}
                    {!['won', 'lost'].includes(l.stage) ? (
                      <div className="kact">
                        {NEXT[l.stage] && <button className="btn tiny"
                          onClick={() => move.mutate({ id: l.id, stage: NEXT[l.stage]! })}>→ {NEXT[l.stage]}</button>}
                        <button className="btn tiny" onClick={() => convert.mutate(l.id)}>Convert</button>
                      </div>
                    ) : l.converted_client ? <div className="kmeta good">→ {l.converted_client}</div> : null}
                  </div>
                )) : <div className="kempty">Nothing here</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- quotes */

const QUOTE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'flat'> = {
  draft: 'flat', sent: 'warn', viewed: 'warn', accepted: 'good', rejected: 'bad', expired: 'flat',
};

export function Quotes() {
  const { perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['quotes'], queryFn: () => api<{ quotes: Quote[] }>('/quotes') });
  const [decline, setDecline] = useState<Quote | null>(null);

  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: unknown }) =>
      api(`/quotes/${id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => { toast('Done'); setDecline(null); void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;

  return (
    <>
      <div className="head"><div><div className="eyebrow">Sales</div><h1>Quotes</h1>
        <div className="sub">{q.data?.quotes.filter(x => ['sent', 'viewed'].includes(x.status)).length ?? 0} awaiting a decision</div></div></div>
      <Card>
        {q.isLoading ? <Skeleton /> : !q.data?.quotes.length ? (
          <Empty title="No quotes yet.">Convert a lead, then quote the work.</Empty>
        ) : (
          <Table head={<tr><th>Number</th><th>Title</th><th>Client</th><th className="r">Total</th>
            <th className="r">Expires</th><th className="r">Status</th><th /></tr>}>
            {q.data.quotes.map(x => (
              <tr key={x.id}>
                <td className="num">{x.number}</td>
                <td className="pname">{x.title}</td>
                <td className="pclient">{x.client_name}</td>
                <td className="r num">{usd(x.total)}</td>
                <td className="r num">{dayLabel(x.expires_on)}</td>
                <td className="r"><Chip tone={QUOTE_TONE[x.status] ?? 'flat'}>{x.status}</Chip></td>
                <td className="r nowrap">
                  <a className="btn tiny" href={`/api/quotes/${x.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  {x.status === 'draft' && !perms?.isClient &&
                    <button className="btn tiny" onClick={() => act.mutate({ id: x.id, path: 'send' })}>Send</button>}
                  {['sent', 'viewed'].includes(x.status) && perms?.canApproveMilestone && <>
                    <button className="btn tiny pri"
                      onClick={() => act.mutate({ id: x.id, path: 'decision', body: { decision: 'accepted' } })}>Accept</button>
                    <button className="btn tiny" onClick={() => setDecline(x)}>Decline</button>
                  </>}
                  {x.status === 'accepted' && !x.project_id && !perms?.isClient &&
                    <button className="btn tiny pri" onClick={() => act.mutate({ id: x.id, path: 'project' })}>Create project</button>}
                  {x.project_id && <Chip tone="good">project created</Chip>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {decline && (
        <Confirm title="Decline this quote?" danger confirmLabel="Decline"
          body={<>Decline <b>{decline.number}</b>? The agency is notified straight away.</>}
          onConfirm={() => act.mutate({ id: decline.id, path: 'decision', body: { decision: 'rejected' } })}
          onClose={() => setDecline(null)} />
      )}
    </>
  );
}

/* --------------------------------------------------------------- tasks */

const COLUMNS = [['backlog', 'Backlog'], ['todo', 'To do'], ['doing', 'In progress'],
  ['review', 'Review'], ['done', 'Done']] as const;
const PRI: Record<string, 'bad' | 'warn' | 'flat'> = { urgent: 'bad', high: 'warn', medium: 'flat', low: 'flat' };

type TaskView = 'kanban' | 'list' | 'calendar';

export function Tasks() {
  const { user, perms } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState<TaskView>('kanban');
  const [assignee, setAssignee] = useState('');
  const q = useQuery({ queryKey: ['tasks'], queryFn: () => api<{ tasks: Task[] }>('/tasks') });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/tasks/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;
  const all = q.data?.tasks ?? [];
  const tasks = assignee === 'mine' ? all.filter(t => t.assignee_id === user?.id) : all;
  const keys = COLUMNS.map(c => c[0]) as readonly string[];

  return (
    <>
      <div className="head">
        <div><div className="eyebrow">Delivery</div><h1>Tasks</h1>
          <div className="sub">{all.filter(t => t.status !== 'done').length} open ·
            {' '}{all.filter(t => t.assignee_id === user?.id).length} assigned to you</div></div>
        <div className="viewbar">
          <select value={assignee} onChange={e => setAssignee(e.target.value)} aria-label="Filter by assignee">
            <option value="">Everyone</option>
            <option value="mine">Assigned to me</option>
          </select>
          <div className="seg-toggle">
            {(['kanban', 'list', 'calendar'] as const).map(v => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v}</button>
            ))}
          </div>
        </div>
      </div>

      {q.isLoading ? <Card><Skeleton /></Card>
        : view === 'calendar' ? <Card><div className="pad"><Calendar tasks={tasks} /></div></Card>
        : view === 'list' ? (
        <Card>
          <Table head={<tr><th>Task</th><th>Project</th><th>Assignee</th><th>Priority</th>
            <th className="r">Estimate</th><th className="r">Due</th><th className="r">Status</th></tr>}>
            {tasks.map(t => (
              <tr key={t.id}>
                <td className="pname">{t.title}</td>
                <td className="pclient">{t.project_name}</td>
                <td>{t.assignee_name ?? <span style={{ color: 'var(--muted)' }}>unassigned</span>}</td>
                <td><Chip tone={PRI[t.priority]}>{t.priority}</Chip></td>
                <td className="r num">{t.estimate_hours ? `${Math.round(t.logged_hours)}/${t.estimate_hours}h` : '—'}</td>
                <td className="r num" style={{ color: t.due_on && daysTo(t.due_on) < 0 && t.status !== 'done'
                  ? 'var(--cost)' : undefined }}>{dayLabel(t.due_on)}</td>
                <td className="r"><Chip tone={t.status === 'done' ? 'good' : 'flat'}>{label(t.status)}</Chip></td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : (
        <div className="kanban">
          {COLUMNS.map(([key, name]) => {
            const col = tasks.filter(t => t.status === key);
            const est = col.reduce((s, t) => s + Number(t.estimate_hours ?? 0), 0);
            const i = keys.indexOf(key);
            return (
              <div key={key} className="kcol">
                <div className="khead"><span>{name}</span><em>{col.length}{est ? ` · ${est}h` : ''}</em></div>
                {col.length ? col.map(t => (
                  <div key={t.id} className={`kcard ${t.due_on && daysTo(t.due_on) < 0 && t.status !== 'done' ? 'late' : ''}`}>
                    <div className="kname">{t.title}</div>
                    <div className="kmeta">{t.project_name}</div>
                    <div className="krow"><Chip tone={PRI[t.priority]}>{t.priority}</Chip>
                      {t.estimate_hours ? <span className="num" style={{ fontSize: 11 }}>
                        {Math.round(t.logged_hours)}/{t.estimate_hours}h</span> : null}</div>
                    <div className="kmeta">{t.assignee_name ?? 'unassigned'}{t.due_on ? ` · ${dayLabel(t.due_on)}` : ''}</div>
                    {!perms?.isClient && (
                      <div className="kact">
                        {i > 0 && <button className="btn tiny" onClick={() => move.mutate({ id: t.id, status: keys[i - 1]! })}>←</button>}
                        {i < keys.length - 1 && <button className="btn tiny"
                          onClick={() => move.mutate({ id: t.id, status: keys[i + 1]! })}>→ {COLUMNS[i + 1]![1]}</button>}
                      </div>
                    )}
                  </div>
                )) : <div className="kempty">Nothing here</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ expenses */

export function Expenses() {
  const { perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['expenses'], queryFn: () => api<{ expenses: Expense[] }>('/expenses') });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api(`/expenses/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => { toast(v.action === 'approve' ? 'Approved — now counted as project cost' : 'Rejected');
      void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;
  const rows = q.data?.expenses ?? [];
  const approved = rows.filter(e => e.status === 'approved');

  return (
    <>
      <div className="head"><div><div className="eyebrow">Cost</div><h1>Expenses</h1>
        <div className="sub">{usd(approved.reduce((s, e) => s + Number(e.amount_base), 0))} approved and counting
          against project margin · {rows.filter(e => e.status === 'submitted').length} awaiting a decision</div></div></div>
      <Card>
        {q.isLoading ? <Skeleton /> : !rows.length ? (
          <Empty title="No expenses recorded.">Project cost is labour only until you add them.</Empty>
        ) : (
          <Table head={<tr><th>Date</th><th>Description</th><th>Project</th><th>Category</th>
            <th className="r ledgerline">Amount</th><th className="r">Status</th><th /></tr>}>
            {rows.map(e => (
              <tr key={e.id}>
                <td className="num">{e.incurred_on.slice(0, 10)}</td>
                <td>{e.description}<div className="pclient">{e.submitted_by ?? ''}</div></td>
                <td className="pclient">{e.project_name ?? '—'}</td>
                <td><Chip>{e.category}</Chip></td>
                <td className="r num ledgerline" style={{ color: 'var(--cost)' }}>{usd(e.amount_base)}</td>
                <td className="r"><Chip tone={e.status === 'approved' ? 'good' : e.status === 'rejected' ? 'bad' : 'warn'}>
                  {e.status}</Chip></td>
                <td className="r nowrap">{e.status === 'submitted' && perms?.canInvoice && <>
                  <button className="btn tiny pri" onClick={() => decide.mutate({ id: e.id, action: 'approve' })}>Approve</button>
                  <button className="btn tiny" onClick={() => decide.mutate({ id: e.id, action: 'reject' })}>Reject</button>
                </>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ invoices */

interface InvoiceData { invoices: Invoice[]; unbilled: { project_id: string; name: string; billing_type: string; amount: number; lines: number }[] }

export function Invoices() {
  const { perms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [paying, setPaying] = useState<Invoice | null>(null);
  const q = useQuery({ queryKey: ['invoices'], queryFn: () => api<InvoiceData>('/invoices') });

  const draft = useMutation({
    mutationFn: (project_id: string) =>
      api<{ invoice: { number: string; total: number; locked_entries: number } }>('/invoices',
        { method: 'POST', body: { project_id } }),
    onSuccess: r => { toast(`${r.invoice.number} drafted — ${r.invoice.locked_entries} time entries locked`);
      void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });
  const send = useMutation({
    mutationFn: (id: string) => api<{ invoice: { number: string } }>(`/invoices/${id}/send`, { method: 'POST' }),
    onSuccess: r => { toast(`${r.invoice.number} sent`); void qc.invalidateQueries(); },
    onError: (e: ApiError) => toast(e.message, 'bad'),
  });

  if (q.error) return <ErrorState error={q.error as Error} />;

  return (
    <>
      <div className="head"><div><div className="eyebrow">Cash</div><h1>Invoices</h1>
        <div className="sub">{q.data?.invoices.filter(i => i.status !== 'paid').length ?? 0} unpaid ·
          {' '}{q.data?.unbilled.length ?? 0} ready to invoice</div></div></div>

      <div className="split wide">
        <Card title="Issued">
          {q.isLoading ? <Skeleton /> : (
            <Table head={<tr><th>Number</th><th>Project</th><th className="r">Total</th><th className="r">Paid</th>
              <th className="r">Due</th><th className="r">Status</th><th /></tr>}>
              {q.data!.invoices.map(i => {
                const over = i.status !== 'paid' && i.days_overdue > 0;
                return (
                  <tr key={i.id}>
                    <td className="num">{i.number}</td>
                    <td>{i.project_name ?? '—'}<div className="pclient">{i.client_name}</div></td>
                    <td className="r num">{usd(i.total)}</td>
                    <td className="r num" style={{ color: Number(i.amount_paid) > 0 ? 'var(--good)' : 'var(--muted)' }}>
                      {Number(i.amount_paid) > 0 ? usd(i.amount_paid) : '—'}</td>
                    <td className="r num" style={{ color: over ? 'var(--cost)' : undefined }}>
                      {over ? `${i.days_overdue}d overdue` : dayLabel(i.due_on)}</td>
                    <td className="r"><Chip tone={i.status === 'paid' ? 'good' : over ? 'bad' : 'warn'}>
                      {over ? 'overdue' : label(i.status)}</Chip></td>
                    <td className="r nowrap">
                      <a className="btn tiny" href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                      {i.status === 'draft' && perms?.canInvoice &&
                        <button className="btn tiny" onClick={() => send.mutate(i.id)}>Send</button>}
                      {!['draft', 'paid', 'void'].includes(i.status) && perms?.canInvoice &&
                        <button className="btn tiny pri" onClick={() => setPaying(i)}>Record payment</button>}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>

        <Card title="Ready to invoice" meta={String(q.data?.unbilled.length ?? 0)}>
          {q.data?.unbilled.length ? q.data.unbilled.map(u => (
            <div key={u.project_id} className="alert info">
              <div className="ic">→</div>
              <div style={{ flex: 1 }}><div className="t">{u.name}</div>
                <div className="d">{u.billing_type === 'hourly'
                  ? `Billable time no invoice has claimed, across ${u.lines} people`
                  : `${u.lines} signed-off milestone${u.lines === 1 ? '' : 's'} waiting`}</div></div>
              <div style={{ textAlign: 'right' }}>
                <div className="num" style={{ fontSize: 15 }}>{usd(u.amount)}</div>
                {perms?.canInvoice && <button className="btn tiny" style={{ marginTop: 5 }}
                  disabled={draft.isPending} onClick={() => draft.mutate(u.project_id)}>Draft invoice</button>}
              </div>
            </div>
          )) : <Empty title="Everything delivered is invoiced.">Nothing is sitting unbilled.</Empty>}
        </Card>
      </div>

      {paying && <PaymentModal invoice={paying} onClose={() => setPaying(null)} />}
    </>
  );
}

function PaymentModal({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const balance = Number(invoice.balance);
  const [f, setF] = useState({
    amount: balance > 0 ? balance.toFixed(2) : '', method: 'bank_transfer',
    reference: '', received_on: new Date().toISOString().slice(0, 10),
  });
  const [err, setErr] = useState('');

  const detail = useQuery({
    queryKey: ['payments', invoice.id],
    queryFn: () => api<{ payments: { id: string; amount: number; received_on: string; reference: string | null; is_refund: boolean }[] }>(
      `/invoices/${invoice.id}/payments`),
  });

  const pay = useMutation({
    mutationFn: () => api<{ invoice: { number: string; status: string }; overpaid: number }>(
      `/invoices/${invoice.id}/payments`,
      { method: 'POST', body: { amount: f.amount, method: f.method, reference: f.reference || undefined, received_on: f.received_on } }),
    onSuccess: r => {
      toast(r.overpaid > 0
        ? `Recorded — ${usd(r.overpaid)} more than the invoice. Worth checking.`
        : `${r.invoice.number} is now ${label(r.invoice.status)}`);
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  return (
    <Modal title="Record a payment" meta={invoice.number} onClose={onClose}>
      <form className="pad" onSubmit={e => { e.preventDefault(); pay.mutate(); }}>
        <dl className="kv" style={{ marginBottom: 16 }}>
          <dt>Invoice</dt><dd>{usd(invoice.total)}</dd>
          <dt>Received</dt><dd>{usd(invoice.amount_paid)}</dd>
          <dt>Balance</dt><dd style={{ color: balance > 0 ? 'var(--cost)' : 'var(--good)' }}>{usd(balance)}</dd>
        </dl>
        {!!detail.data?.payments.length && (
          <div className="hint" style={{ marginBottom: 14 }}>
            {detail.data.payments.map(p => (
              <div key={p.id}>{p.is_refund ? 'Refund' : 'Paid'} {usd(Math.abs(p.amount))} ·
                {' '}{p.received_on.slice(0, 10)}{p.reference ? ` · ${p.reference}` : ''}</div>
            ))}
          </div>
        )}
        <Field label="Amount"><input type="number" step="0.01" min="0.01" value={f.amount}
          onChange={e => setF({ ...f, amount: e.target.value })} required autoFocus /></Field>
        <Field label="Method">
          <select value={f.method} onChange={e => setF({ ...f, method: e.target.value })}>
            {['bank_transfer', 'wise', 'payoneer', 'card', 'cash', 'other'].map(m =>
              <option key={m} value={m}>{label(m)}</option>)}
          </select></Field>
        <Field label="Reference"><input value={f.reference}
          onChange={e => setF({ ...f, reference: e.target.value })} placeholder="Bank reference or transaction id" /></Field>
        <Field label="Received on"><input type="date" value={f.received_on}
          onChange={e => setF({ ...f, received_on: e.target.value })} /></Field>
        {err && <div className="err">{err}</div>}
        <div className="modal-act">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={pay.isPending}>{pay.isPending ? 'Saving…' : 'Record payment'}</button>
        </div>
      </form>
    </Modal>
  );
}

export { Redacted };
