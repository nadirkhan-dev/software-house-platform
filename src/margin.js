/**
 * The margin engine.
 *
 * Nothing here recomputes historical cost. `project_margin` reads time entries
 * whose rate card and FX rate were frozen the day the work was logged, so a
 * currency move or a pay rise changes tomorrow's numbers and leaves last
 * quarter's alone.
 */

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/** Rows from the view, plus the derived figures the UI actually renders. */
export async function projectMargins(c) {
  const { rows } = await c.query(`
    SELECT pm.*, p.starts_on, p.due_on, p.status, cl.name AS client_name, cl.country
      FROM project_margin pm
      JOIN projects p ON p.id = pm.project_id
      JOIN clients cl ON cl.id = pm.client_id
     ORDER BY pm.cost_base DESC`);
  return rows.map(derive);
}

export function derive(r) {
  const today = new Date();
  const margin = r.revenue_base - r.cost_base;
  const marginPct = r.revenue_base > 0 ? margin / r.revenue_base : 0;
  const burn = r.budget_cost > 0 ? r.cost_base / r.budget_cost : 0;

  const total = r.due_on ? Math.max(1, daysBetween(r.starts_on, r.due_on)) : 1;
  const gone = Math.max(0, daysBetween(r.starts_on, today));
  const elapsed = Math.min(1.5, gone / total);

  // Cost at completion, extrapolated from what a unit of progress has cost so
  // far. Below 5% delivered the ratio is noise, so fall back to a crude 4x.
  const projCost = r.progress > 0.05 ? r.cost_base / r.progress : r.cost_base * 4;
  const projMargin = r.contract_value > 0 ? (r.contract_value - projCost) / r.contract_value : 0;

  let health = 'good';
  if (burn > r.progress + 0.15 || projMargin < r.target_margin * 0.6) health = 'warn';
  if (burn > 1 || projMargin < 0.1) health = 'bad';

  return { ...r, margin, marginPct, burn, elapsed, projCost, projMargin, health };
}

export function portfolio(rows) {
  const sum = f => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const contracted = sum(r => r.contract_value);
  const revenue = sum(r => r.revenue_base);
  const cost = sum(r => r.cost_base);
  const projCost = sum(r => r.projCost);
  const hours = sum(r => r.hours);
  return {
    projects: rows.length,
    contracted, revenue, cost, hours, projCost,
    billableHours: sum(r => r.billable_hours),
    costHome: sum(r => r.cost_home),
    quoted: contracted > 0 ? sum(r => r.contract_value * r.target_margin) / contracted : 0,
    projMargin: contracted > 0 ? (contracted - projCost) / contracted : 0,
    realised: revenue > 0 ? (revenue - cost) / revenue : 0,
    effRate: hours > 0 ? revenue / hours : 0,
  };
}

const usd = n => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const pct = n => (n * 100).toFixed(1) + '%';

/**
 * Alerts answer to the caller's permissions, exactly like every other figure.
 * A masked dashboard above a notification quoting the budget is not a policy.
 */
export function alerts(rows, extra, perms) {
  const out = [];
  const { seesCost, seesRevenue } = perms;

  for (const r of rows) {
    if (r.progress < r.elapsed - 0.12) out.push({
      lv: 'warn', ic: '◷', project_id: r.project_id,
      t: `${r.name} is behind schedule`,
      d: `${pct(r.progress)} of milestones signed off with ${pct(r.elapsed)} of the timeline gone.`,
    });

    if (!seesCost) continue;

    if (r.burn > 1) out.push({
      lv: 'crit', ic: '!!', project_id: r.project_id,
      t: `${r.name} has spent its entire cost budget`,
      d: `${usd(r.cost_base)} spent against a ${usd(r.budget_cost)} budget, with ${pct(r.progress)} of milestones done. Finishing at this rate lands the job at ${pct(r.projMargin)} margin.`,
    });
    else if (r.burn > r.progress + 0.15) out.push({
      lv: 'warn', ic: '▲', project_id: r.project_id,
      t: `${r.name} is burning faster than it is delivering`,
      d: `${pct(r.burn)} of budget consumed at ${pct(r.progress)} complete. Projected margin ${pct(r.projMargin)} against a ${pct(r.target_margin)} target.`,
    });

    if (r.effective_rate && r.effective_rate < 22 && r.billing_type !== 'retainer') out.push({
      lv: 'warn', ic: '≈', project_id: r.project_id,
      t: `${r.name} is earning ${usd(r.effective_rate)}/hour`,
      d: `Below your $28/hour floor. On a fixed bid this is what a quote that was too low looks like once the hours land.`,
    });
  }

  if (seesCost) for (const co of extra.absorbed) out.push({
    lv: 'warn', ic: '+', project_id: co.project_id,
    t: `Unbilled scope on ${co.project_name}`,
    d: `"${co.title}" — ${co.est_hours} hours, never turned into a change order. That is ${usd(co.est_hours * 38)} of work given away.`,
  });

  if (seesRevenue) for (const i of extra.overdue) out.push({
    lv: 'crit', ic: '$', project_id: i.project_id,
    t: `${i.number} is ${i.days_overdue} days overdue`,
    d: `${usd(i.total)} from ${i.client_name}, past due, and the team has logged ${Math.round(i.hours_since)}h to them since.`,
  });

  if (seesCost && extra.fx && Math.abs(extra.fx.change) > 2) out.push({
    lv: 'info', ic: '⇄',
    t: `USD/PKR moved ${extra.fx.change > 0 ? '+' : ''}${extra.fx.change.toFixed(2)} in 30 days`,
    d: `Historical costs are held at the rate on the day the work happened, so your past margins have not changed. New hours convert at ${extra.fx.today.toFixed(2)}.`,
  });

  const order = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.lv] - order[b.lv]);
}
