import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, ErrorState, Empty, Skeleton, Table } from '../components/ui';
import { useToast } from '../lib/toast';
import { has, hrs, pct, pkr, usd, usdK } from '../lib/format';

/* ------------------------------------------------------------ timesheet */

interface TimeData {
  start: string;
  entries: { id: string; project_id: string; worked_on: string; hours: number; locked: boolean }[];
  projects: { id: string; name: string; client_name: string }[];
  totals: { hours: number; cost_home?: number; cost_base?: number; value_base?: number };
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Timesheet() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['time'], queryFn: () => api<TimeData>('/time') });
  const [saving, setSaving] = useState('');

  const save = useMutation({
    mutationFn: (v: { project_id: string; worked_on: string; hours: number }) =>
      api('/time', { method: 'PUT', body: v }),
    onMutate: () => setSaving('Saving…'),
    onSuccess: () => { setSaving('Saved'); setTimeout(() => setSaving(''), 1400); void qc.invalidateQueries({ queryKey: ['time'] }); },
    onError: (e: ApiError) => { setSaving(''); toast(e.message, 'bad'); void qc.invalidateQueries({ queryKey: ['time'] }); },
  });

  if (q.error) return <ErrorState error={q.error as Error} />;
  if (q.isLoading) return <Card><Skeleton rows={4} /></Card>;
  const d = q.data!;
  const days = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d.start + 'T00:00:00'); x.setDate(x.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
  const cell = (pid: string, day: string) =>
    d.entries.find(e => e.project_id === pid && e.worked_on.slice(0, 10) === day);

  return (
    <>
      <div className="head">
        <div><div className="eyebrow">Week of {d.start}</div><h1>Timesheet</h1>
          <div className="sub">Each hour is costed at your rate card and the day's exchange rate,
            both frozen the moment you save.</div></div>
        <span className="saving">{saving}</span>
      </div>
      <div className="split">
        <Card title="Hours" meta={`${d.projects.length} assigned project${d.projects.length === 1 ? '' : 's'}`} className="ts">
          {d.projects.length ? (
            <Table head={<tr><th>Project</th>{DAYS.map(n => <th key={n} className="r day">{n}</th>)}
              <th className="r">Total</th></tr>}>
              {d.projects.map(p => (
                <tr key={p.id}>
                  <td style={{ paddingLeft: 13 }}><div className="pname" style={{ fontSize: 13 }}>{p.name}</div>
                    <div className="pclient">{p.client_name}</div></td>
                  {days.map(day => {
                    const e = cell(p.id, day);
                    return (
                      <td key={day}>
                        <input type="number" step="0.5" min="0" max="24"
                          defaultValue={e ? Number(e.hours) : ''} disabled={e?.locked}
                          title={e?.locked ? 'Already invoiced' : undefined}
                          aria-label={`${p.name} ${day}`}
                          onBlur={ev => {
                            const v = ev.target.value === '' ? 0 : Number(ev.target.value);
                            if (v === Number(e?.hours ?? 0)) return;
                            save.mutate({ project_id: p.id, worked_on: day, hours: v });
                          }} />
                      </td>
                    );
                  })}
                  <td className="r num">{hrs(d.entries.filter(e => e.project_id === p.id)
                    .reduce((s, e) => s + Number(e.hours), 0))}</td>
                </tr>
              ))}
            </Table>
          ) : <Empty title="You are not on a project this week.">Ask a lead to add you.</Empty>}
        </Card>

        <Card title="What this week costs">
          <div className="impact">
            <Cell label="Hours" value={Number(d.totals.hours).toFixed(1)} />
            <Cell label="Cost (PKR)" value={has(d.totals.cost_home) ? pkr(d.totals.cost_home!) : null} tone="var(--cost)" />
            <Cell label="Cost (USD)" value={has(d.totals.cost_base) ? usd(d.totals.cost_base!) : null} tone="var(--cost)" />
            <Cell label="Billed value" value={has(d.totals.value_base) ? usd(d.totals.value_base!) : null} tone="var(--rev)" />
            <Cell label="Margin added" value={has(d.totals.value_base) && has(d.totals.cost_base)
              ? usd(d.totals.value_base! - d.totals.cost_base!) : null} />
            <Cell label="Spread" value={has(d.totals.cost_base) && d.totals.cost_base! > 0
              ? `${(d.totals.value_base! / d.totals.cost_base!).toFixed(1)}×` : null} />
          </div>
          <div className="pad hint">
            {has(d.totals.cost_home)
              ? 'Cost is your rate card in PKR, loaded 1.9× for overhead, converted at each day\u2019s rate.'
              : 'Your hours are costed against your rate card. The figures are hidden at your permission level.'}
          </div>
        </Card>
      </div>
    </>
  );
}

const Cell = ({ label, value, tone }: { label: string; value: string | null; tone?: string }) => (
  <div className="icell"><div className="l">{label}</div>
    <div className="v" style={{ color: value ? tone : undefined }}>
      {value ?? <span className="red num">▨▨▨▨▨</span>}</div></div>
);

/* -------------------------------------------------------------- reports */

interface ReportData {
  options: {
    clients: { id: string; name: string }[];
    projects: { id: string; name: string; client_id: string }[];
    team: { id: string; full_name: string }[];
  };
  revenue: { month: string; invoiced: number; collected: number; labour_cost?: number; expenses?: number; gross_profit?: number }[];
  projects: { project_id: string; name: string; client_name: string; contract_value: number;
              revenue_base: number; cost_base?: number; gross_profit?: number; margin?: number }[];
  clients: { id: string; name: string; projects: number; revenue: number; gross_profit?: number }[];
  team: { full_name: string; role: string; billable: number; non_billable: number; utilisation: number; contributed: number }[];
  aging: { bucket: string; count: number; outstanding: number }[];
}

interface Filters { from: string; to: string; client: string; project: string; user: string }
const EMPTY: Filters = { from: '', to: '', client: '', project: '', user: '' };

export function Reports() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  const q = useQuery({
    queryKey: ['reports', query],
    queryFn: () => api<ReportData>('/reports' + (query ? `?${query}` : '')),
    // Keeps the previous figures on screen while a filter change loads, so the
    // page does not blink back to skeletons on every dropdown.
    placeholderData: prev => prev,
  });

  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters(f => ({ ...f, [k]: e.target.value, ...(k === 'client' ? { project: '' } : {}) }));
  const active = Object.values(filters).some(Boolean);

  if (q.error) return <ErrorState error={q.error as Error} />;
  if (q.isLoading || !q.data) return <Card><Skeleton rows={6} /></Card>;
  const d = q.data;
  const seesCost = d.revenue.some(m => has(m.gross_profit));
  // Only projects belonging to the chosen client, so the two dropdowns cannot
  // be set to a combination that returns nothing.
  const projectOptions = filters.client
    ? d.options.projects.filter(p => p.client_id === filters.client)
    : d.options.projects;
  const peak = Math.max(...d.revenue.map(m =>
    Number(m.invoiced) + (seesCost ? Number(m.labour_cost ?? 0) + Number(m.expenses ?? 0) : 0)), 1);
  const ytd = d.revenue.reduce((a, m) => ({
    invoiced: a.invoiced + Number(m.invoiced), collected: a.collected + Number(m.collected),
    cost: a.cost + Number(m.labour_cost ?? 0) + Number(m.expenses ?? 0),
  }), { invoiced: 0, collected: 0, cost: 0 });

  return (
    <>
      <div className="head"><div><div className="eyebrow">Business intelligence</div><h1>Reports</h1>
        <div className="sub">Every figure derived from source records — no stored rollups, so a report
          cannot disagree with the ledger it came from.</div></div></div>

      <div className="filterbar">
        <label>From<input type="date" value={filters.from} onChange={set('from')} /></label>
        <label>To<input type="date" value={filters.to} onChange={set('to')} /></label>
        <label>Client
          <select value={filters.client} onChange={set('client')}>
            <option value="">All clients</option>
            {d.options.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label>Project
          <select value={filters.project} onChange={set('project')}>
            <option value="">All projects</option>
            {projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        {!!d.options.team.length && (
          <label>Team member
            <select value={filters.user} onChange={set('user')}>
              <option value="">Everyone</option>
              {d.options.team.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select></label>
        )}
        {active && <button className="btn tiny" onClick={() => setFilters(EMPTY)}>Clear</button>}
        {q.isFetching && <span className="saving">Updating…</span>}
      </div>

      <Card title="Revenue and cost" meta={`last ${d.revenue.length} months`} className="mb">
        <div className="metrics">
          <Cell label="Invoiced" value={usdK(ytd.invoiced)} />
          <Cell label="Collected" value={usdK(ytd.collected)} tone="var(--good)" />
          {seesCost && <>
            <Cell label="Cost" value={usdK(ytd.cost)} tone="var(--cost)" />
            <Cell label="Gross profit" value={usdK(ytd.invoiced - ytd.cost)} />
            <Cell label="Margin" value={ytd.invoiced > 0 ? pct((ytd.invoiced - ytd.cost) / ytd.invoiced) : '—'} />
          </>}
        </div>
        <div className="pad">
          <div className="chart">
            {d.revenue.map(m => {
              const cost = Number(m.labour_cost ?? 0) + Number(m.expenses ?? 0);
              const scale = 150 / peak;
              return (
                <div key={m.month} className="bar"
                  title={`${m.month.slice(0, 7)}: invoiced ${usdK(m.invoiced)}${seesCost ? `, cost ${usdK(cost)}` : ''}`}>
                  <div className="stack">
                    <i style={{ height: Math.round(Number(m.invoiced) * scale), background: 'var(--rev)' }} />
                    {seesCost && <i style={{ height: Math.round(cost * scale), background: 'var(--cost)' }} />}
                  </div>
                  <span>{new Date(m.month).toLocaleDateString('en-GB', { month: 'short' })}</span>
                </div>
              );
            })}
          </div>
          <div className="lkey" style={{ marginTop: 10 }}>
            <span><i style={{ background: 'var(--rev)' }} />Invoiced</span>
            {seesCost && <span><i style={{ background: 'var(--cost)' }} />Labour and expenses</span>}
          </div>
        </div>
      </Card>

      {!d.projects.length && (
        <Card className="mb"><Empty title="Nothing matches those filters.">
          Widen the date range, or clear a filter to see the whole book.
        </Empty></Card>
      )}

      <div className="split">
        <Card title="Project profitability">
          <Table head={<tr><th>Project</th><th>Client</th><th className="r">Contract</th><th className="r">Revenue</th>
            {seesCost && <><th className="r ledgerline">Cost</th><th className="r">Profit</th><th className="r">Margin</th></>}</tr>}>
            {d.projects.map(p => (
              <tr key={p.project_id}>
                <td className="pname">{p.name}</td><td className="pclient">{p.client_name}</td>
                <td className="r num">{usdK(p.contract_value)}</td>
                <td className="r num">{usdK(p.revenue_base)}</td>
                {seesCost && <>
                  <td className="r num ledgerline" style={{ color: 'var(--cost)' }}>{usdK(p.cost_base!)}</td>
                  <td className="r num" style={{ color: p.gross_profit! < 0 ? 'var(--cost)' : 'var(--good)' }}>
                    {usdK(p.gross_profit!)}</td>
                  <td className="r num">{p.margin == null ? '—' : pct(p.margin)}</td>
                </>}
              </tr>
            ))}
          </Table>
        </Card>
        <div className="grid">
          <Card title="Invoice ageing">
            <Table head={<tr><th>Bucket</th><th className="r">Count</th><th className="r">Outstanding</th></tr>}>
              {d.aging.map(a => (
                <tr key={a.bucket}>
                  <td><span className={`chip ${a.bucket === 'paid' ? 'good' : a.bucket === 'current' ? 'flat'
                    : a.bucket === '60+ days' ? 'bad' : 'warn'}`}>{a.bucket}</span></td>
                  <td className="r num">{a.count}</td><td className="r num">{usd(a.outstanding)}</td></tr>
              ))}
            </Table>
          </Card>
          <Card title="By client">
            <Table head={<tr><th>Client</th><th className="r">Revenue</th>{seesCost && <th className="r">Profit</th>}</tr>}>
              {d.clients.map(c => (
                <tr key={c.id}><td>{c.name}<div className="pclient">{c.projects} project{c.projects === 1 ? '' : 's'}</div></td>
                  <td className="r num">{usdK(c.revenue)}</td>
                  {seesCost && <td className="r num">{usdK(c.gross_profit!)}</td>}</tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>

      {!!d.team.length && (
        <Card title="Utilisation" meta="last 30 days" className="mb" >
          <Table head={<tr><th>Person</th><th>Role</th><th className="r">Billable</th><th className="r">Non-billable</th>
            <th style={{ width: 140 }}>Utilisation</th><th className="r">Contributed</th></tr>}>
            {d.team.map(t => (
              <tr key={t.full_name}>
                <td className="pname">{t.full_name}</td><td><span className="chip flat">{t.role}</span></td>
                <td className="r num">{hrs(t.billable)}</td><td className="r num">{hrs(t.non_billable)}</td>
                <td><div className="mini"><i style={{ width: `${Math.min(100, (t.utilisation || 0) * 100)}%`,
                  background: t.utilisation > 0.75 ? 'var(--good)' : t.utilisation > 0.55 ? 'var(--warn)' : 'var(--cost)' }} /></div>
                  <div className="hint" style={{ marginTop: 4 }}>{pct(t.utilisation || 0)}</div></td>
                <td className="r num">{usd(t.contributed)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- team */

export function Team() {
  const { perms } = useSession();
  const q = useQuery({ queryKey: ['team'], queryFn: () => api<{ team: Record<string, number | string | null>[] }>('/team') });
  if (q.error) return <ErrorState error={q.error as Error} />;
  return (
    <>
      <div className="head"><div><div className="eyebrow">Capacity</div><h1>Team</h1>
        <div className="sub">Cost rates in PKR, bill rates in USD. The gap between them is the business.</div></div></div>
      <Card title="Rate card" meta="last 30 days">
        {q.isLoading ? <Skeleton /> : (
          <Table head={<tr><th>Person</th><th>Role</th><th className="r ledgerline">Cost / hr</th>
            <th className="r">Bill / hr</th><th className="r">Hours</th><th className="r">Billable</th>
            <th style={{ width: 135 }}>Utilisation</th>{perms?.seesCost && <th className="r">Contributed</th>}</tr>}>
            {q.data!.team.map((t, i) => {
              const costHr = t.cost_hour_home == null ? null : Number(t.cost_hour_home) / 284.6;
              const util = Number(t.utilisation ?? 0);
              return (
                <tr key={i}>
                  <td className="pname">{String(t.full_name)}</td>
                  <td><span className="chip flat">{String(t.role)}</span></td>
                  <td className="r num ledgerline" style={{ color: 'var(--cost)' }}>
                    {costHr == null ? <span className="red num">▨▨▨▨▨</span> : usd(costHr)}</td>
                  <td className="r num" style={{ color: 'var(--rev)' }}>{usd(Number(t.bill_rate ?? 0))}</td>
                  <td className="r num">{hrs(Number(t.hours ?? 0))}</td>
                  <td className="r num">{hrs(Number(t.billable ?? 0))}</td>
                  <td><div className="mini"><i style={{ width: `${Math.min(100, util * 100)}%`,
                    background: util > 0.75 ? 'var(--good)' : util > 0.55 ? 'var(--warn)' : 'var(--cost)' }} /></div>
                    <div className="hint" style={{ marginTop: 4 }}>{pct(util)}</div></td>
                  {perms?.seesCost && <td className="r num">{usd(Number(t.contributed ?? 0))}</td>}
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
