import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, ErrorState, Health, Money, Redacted, Skeleton } from '../components/ui';
import { LedgerBar } from '../components/LedgerBar';
import { has, pct, pkr, usd, usdK } from '../lib/format';
import type { Dashboard as D } from '../lib/types';

export function Dashboard() {
  const { perms } = useSession();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<D>('/dashboard') });

  if (q.isLoading) return <><h1>Loading…</h1><Card><Skeleton rows={6} /></Card></>;
  if (q.error) return <ErrorState error={q.error as Error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const p = d.portfolio;
  const seesCost = has(p.cost);
  const title = seesCost ? 'Are we making money?' : perms?.seesRevenue ? 'How is delivery tracking?' : 'Your work';

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Portfolio · {d.projects.length} active project{d.projects.length === 1 ? '' : 's'}</div>
          <h1>{title}</h1>
          <div className="sub">Cost converted at the rate on the day each hour was logged, not today's.</div>
        </div>
      </div>

      <div className="hero">
        <div className="hero-l">
          <div className="lab">Projected margin at delivery</div>
          <div className="big" style={{ color: seesCost
            ? (p.projMargin! < p.quoted! * 0.8 ? 'var(--cost)' : 'var(--ink)') : 'var(--muted)' }}>
            {seesCost ? pct(p.projMargin!) : '▨▨▨'}
          </div>
          {seesCost && <div className="quoted">quoted at <s>{pct(p.quoted!)}</s></div>}
          <div className="note">
            {seesCost
              ? <>Across {d.projects.length} projects that is <b>{usd(p.contracted! * (p.quoted! - p.projMargin!))}</b> of
                  margin already spent — while there is still time to do something about it.</>
              : <>Margin figures are hidden at your permission level. You can see delivery progress and your own logged time.</>}
          </div>
          {seesCost && (
            <div style={{ marginTop: 20 }}>
              <div className="lbar">
                <div className="seg cost" style={{ width: `${Math.min(100, p.projCost! / p.contracted! * 100)}%` }}>
                  <span>{usdK(p.projCost!)} cost at completion</span></div>
                <div className="seg margin" style={{ width: `${Math.max(0, 100 - p.projCost! / p.contracted! * 100)}%` }}>
                  <span>{usdK(p.contracted! - p.projCost!)}</span></div>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>Whole book, {usdK(p.contracted!)} contracted, left to right.</div>
            </div>
          )}
        </div>
        <div className="hero-r">
          <Metric label="Contracted" value={p.contracted} fmt={usdK} sub={`${d.projects.length} projects`} />
          <Metric label="Cost to date" value={p.cost} fmt={usdK} tone="var(--cost)"
            sub={has(p.costHome) ? pkr(p.costHome!) : '—'} />
          <Metric label="Realised margin" value={p.realised} fmt={pct} sub="on delivered work" />
          <div className="hcell">
            <div className="l">{d.hours.scope === 'own' ? 'Your hours' : 'Hours logged'}</div>
            <div className="v">{Math.round(d.hours.total).toLocaleString()}</div>
            <div className="s">{pct(d.hours.billable / (d.hours.total || 1))} billable</div>
          </div>
          <Metric label="Outstanding" value={d.outstanding} fmt={usdK}
            sub={has(d.overdue) ? `${usdK(d.overdue!)} overdue` : '—'} />
          <Metric label="Eff. rate" value={p.effRate} fmt={usd} sub="per hour, blended" />
        </div>
      </div>

      <div className="split">
        <Card title="Margin ledger" meta="contract value, left to right">
          <div className="pad">
            {d.projects.map(j => (
              <Link key={j.project_id} to={`/projects/${j.project_id}`} className="prow block">
                <div className="prowhead">
                  <div><span className="pname">{j.name}</span> <span className="pclient">· {j.client_name}</span></div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {has(j.contract_value) ? usdK(j.contract_value!) : <Redacted />}</span>
                    <Health value={j.health} />
                  </div>
                </div>
                <LedgerBar project={j} />
              </Link>
            ))}
            {seesCost && (
              <div className="lkey">
                <span><i style={{ background: 'var(--cost)' }} />Cost incurred (PKR → USD at snapshot rate)</span>
                <span><i style={{ background: 'var(--rev)' }} />Margin remaining</span>
                <span><i style={{ background: 'var(--ink)', width: 2, height: 10 }} />Delivery progress</span>
              </div>
            )}
          </div>
        </Card>

        <Card title="Needs attention" meta={String(d.alerts.length)}>
          {d.alerts.length ? d.alerts.slice(0, 8).map((a, i) => (
            <div key={i} className={`alert ${a.lv}`}>
              <div className="ic">{a.ic}</div>
              <div><div className="t">{a.t}</div><div className="d">{a.d}</div></div>
            </div>
          )) : <div className="empty"><b>Nothing is on fire.</b>Every project is inside its budget and ahead of its burn.</div>}
        </Card>
      </div>
    </>
  );
}

function Metric({ label, value, fmt, sub, tone }:
  { label: string; value?: number; fmt: (n: number | string) => string; sub?: string; tone?: string }) {
  return (
    <div className="hcell">
      <div className="l">{label}</div>
      <div className="v" style={{ color: has(value) ? tone : undefined }}><Money value={value} fmt={fmt} /></div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}
