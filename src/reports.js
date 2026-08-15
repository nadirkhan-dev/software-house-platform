/**
 * Global search and reporting.
 *
 * Both run on the RLS-scoped connection, so a developer searching "Northwind"
 * gets only the projects she is staffed on, and a client gets only their own
 * records — without either query mentioning roles. Scoping lives in one place.
 */

/* --------------------------------------------------------------- search */

/**
 * One query per entity rather than a union: each has different columns, a
 * different notion of relevance, and different visibility. A clever single
 * query here would be harder to reason about than six obvious ones.
 *
 * ILIKE with a prefix wildcard is honest at this scale (a few thousand rows per
 * tenant). Past that, add a tsvector column — do not reach for Elasticsearch.
 */
export async function search(c, term, perms) {
  const q = `%${term.replace(/[%_]/g, m => '\\' + m)}%`;
  const out = [];

  const push = (type, rows, map) => rows.forEach(r => out.push({ type, ...map(r) }));

  const clients = await c.query(
    `SELECT id, name, country FROM clients WHERE name ILIKE $1 AND archived_at IS NULL LIMIT 6`, [q]);
  push('client', clients.rows, r => ({ id: r.id, label: r.name, hint: r.country, link: 'projects' }));

  const projects = await c.query(`
    SELECT p.id, p.name, p.status, cl.name AS client_name
      FROM projects p JOIN clients cl ON cl.id = p.client_id
     WHERE p.name ILIKE $1 LIMIT 6`, [q]);
  push('project', projects.rows, r => ({ id: r.id, label: r.name, hint: r.client_name, link: `project:${r.id}` }));

  const tasks = await c.query(`
    SELECT t.id, t.title, t.status, p.name AS project_name
      FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.title ILIKE $1 LIMIT 6`, [q]);
  push('task', tasks.rows, r => ({ id: r.id, label: r.title, hint: `${r.project_name} · ${r.status}`, link: 'tasks' }));

  const milestones = await c.query(`
    SELECT m.id, m.name, m.project_id, p.name AS project_name, m.approved_at
      FROM milestones m JOIN projects p ON p.id = m.project_id
     WHERE m.name ILIKE $1 LIMIT 5`, [q]);
  push('milestone', milestones.rows, r => ({
    id: r.id, label: r.name,
    hint: `${r.project_name} · ${r.approved_at ? 'signed off' : 'open'}`,
    link: `project:${r.project_id}`,
  }));

  if (perms.seesRevenue || perms.isClient) {
    const invoices = await c.query(`
      SELECT i.id, i.number, i.total, i.status, cl.name AS client_name
        FROM invoices i JOIN clients cl ON cl.id = i.client_id
       WHERE i.number ILIKE $1 OR cl.name ILIKE $1 LIMIT 6`, [q]);
    push('invoice', invoices.rows, r => ({
      id: r.id, label: r.number, hint: `${r.client_name} · ${r.status.replace('_', ' ')}`, link: 'invoices' }));

    const quotes = await c.query(`
      SELECT qt.id, qt.number, qt.title, qt.status FROM quotes qt
       WHERE qt.number ILIKE $1 OR qt.title ILIKE $1 LIMIT 5`, [q]);
    push('quote', quotes.rows, r => ({ id: r.id, label: r.number, hint: `${r.title} · ${r.status}`, link: 'quotes' }));
  }

  if (perms.seesRevenue) {
    const people = await c.query(`
      SELECT u.id, u.full_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.is_active AND m.role <> 'client' AND u.full_name ILIKE $1 LIMIT 5`, [q]);
    push('person', people.rows, r => ({ id: r.id, label: r.full_name, hint: r.role, link: 'team' }));

    const leads = await c.query(
      `SELECT id, company, stage FROM leads WHERE company ILIKE $1 LIMIT 5`, [q]);
    push('lead', leads.rows, r => ({ id: r.id, label: r.company, hint: r.stage, link: 'leads' }));
  }

  // Exact prefix matches first — searching "INV-01" should not bury INV-0141.
  const lower = term.toLowerCase();
  return out.sort((a, b) => {
    const ap = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
    const bp = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
    return ap - bp || a.label.length - b.label.length;
  }).slice(0, 20);
}

/* -------------------------------------------------------------- reports */

/**
 * Every figure below is derived from source records. Nothing is a stored
 * rollup, so a report can never disagree with the ledger it came from.
 *
 *   Gross profit = recognised revenue − labour cost − approved expenses
 *
 * Labour cost carries the loaded overhead multiplier and the FX rate frozen on
 * the day each hour was worked, which is why these numbers survive a currency
 * move and a pay rise.
 */

/**
 * Report filters.
 *
 * One builder rather than per-query ad-hoc SQL: the whole point of a filter bar
 * is that every panel narrows to the same slice, and five hand-written WHERE
 * clauses drift apart the first time someone adds a sixth report.
 *
 * `from`/`to` bound the period. `client`, `project` and `user` narrow further.
 * Everything still runs on the RLS-scoped connection, so a filter can only ever
 * narrow what the caller could already see — it can never widen it.
 */
export function buildFilters(q = {}) {
  const f = { args: [], from: null, to: null, client: null, project: null, user: null };
  const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const uuid = v => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : null);
  f.from = date(q.from);
  f.to = date(q.to);
  f.client = uuid(q.client);
  f.project = uuid(q.project);
  f.user = uuid(q.user);
  f.active = Boolean(f.from || f.to || f.client || f.project || f.user);
  return f;
}

/** Which projects the filters admit. NULL means "no project restriction". */
function projectScope(f, params) {
  const parts = [];
  if (f.client) { params.push(f.client); parts.push(`p.client_id = $${params.length}`); }
  if (f.project) { params.push(f.project); parts.push(`p.id = $${params.length}`); }
  if (!parts.length) return null;
  return `SELECT p.id FROM projects p WHERE ${parts.join(' AND ')}`;
}

export async function revenueByMonth(c, months = 12, f = buildFilters()) {
  /* $1 is cast explicitly. When a from/to window replaces the rolling series,
     $1 stops being referenced anywhere and Postgres cannot infer its type —
     "could not determine data type of parameter $1". Casting at the only site
     that uses it, and keeping the cast even when unused, avoids that. */
  const params = [months];
  const scope = projectScope(f, params);
  const inProjects = col => (scope ? ` AND ${col} IN (${scope})` : '');
  let userClause = '';
  if (f.user) { params.push(f.user); userClause = ` AND te.user_id = $${params.length}`; }

  // A from/to window overrides the rolling month count.
  let series = `SELECT date_trunc('month', d)::date AS month
                  FROM generate_series(date_trunc('month', current_date) - ($1::int - 1) * interval '1 month',
                                       date_trunc('month', current_date), interval '1 month') d`;
  if (f.from || f.to) {
    params.push(f.from || '1970-01-01', f.to || '2999-12-31');
    const a = params.length - 1, b = params.length;
    // `$1::int IS NOT NULL` keeps the months parameter referenced and typed
    // without affecting the result — it is always true.
    series = `SELECT date_trunc('month', d)::date AS month
                FROM generate_series(date_trunc('month', $${a}::date),
                                     date_trunc('month', $${b}::date), interval '1 month') d
               WHERE $1::int IS NOT NULL`;
  }

  const { rows } = await c.query(`
    WITH m AS (${series})
    SELECT m.month,
           COALESCE((SELECT sum(i.total) FROM invoices i
                      WHERE date_trunc('month', i.issued_on) = m.month
                        AND i.status <> 'void'${inProjects('i.project_id')}), 0) AS invoiced,
           COALESCE((SELECT sum(pay.amount) FROM payments pay
                      JOIN invoices i2 ON i2.id = pay.invoice_id
                      WHERE date_trunc('month', pay.received_on) = m.month
                        ${inProjects('i2.project_id')}), 0) AS collected,
           COALESCE((SELECT sum(te.cost_base) FROM time_entries te
                      WHERE date_trunc('month', te.worked_on) = m.month
                        ${inProjects('te.project_id')}${userClause}), 0) AS labour_cost,
           COALESCE((SELECT sum(e.amount / e.fx_rate) FROM expenses e
                      WHERE date_trunc('month', e.incurred_on) = m.month
                        AND e.status = 'approved'${inProjects('e.project_id')}), 0) AS expenses
      FROM m ORDER BY m.month`, params);
  return rows.map(r => ({
    ...r,
    gross_profit: Number(r.invoiced) - Number(r.labour_cost) - Number(r.expenses),
  }));
}

export async function profitabilityByProject(c, f = buildFilters()) {
  const params = [];
  const where = [];
  if (f.client) { params.push(f.client); where.push(`pm.client_id = $${params.length}`); }
  if (f.project) { params.push(f.project); where.push(`pm.project_id = $${params.length}`); }
  // A team-member filter means "projects this person worked on", which is the
  // question someone actually asks when they pick a name.
  if (f.user) {
    params.push(f.user);
    where.push(`EXISTS (SELECT 1 FROM time_entries te
                         WHERE te.project_id = pm.project_id AND te.user_id = $${params.length})`);
  }
  const { rows } = await c.query(`
    SELECT pm.project_id, pm.name, pm.client_id, cl.name AS client_name,
           pm.contract_value, pm.revenue_base, pm.cost_base, pm.hours,
           pm.target_margin, pm.progress,
           COALESCE(x.expenses, 0) AS expenses,
           pm.revenue_base - pm.cost_base AS gross_profit,
           CASE WHEN pm.revenue_base > 0
                THEN (pm.revenue_base - pm.cost_base) / pm.revenue_base END AS margin
      FROM project_margin pm
      JOIN clients cl ON cl.id = pm.client_id
      LEFT JOIN LATERAL (
        SELECT sum(amount / fx_rate) expenses FROM expenses e
         WHERE e.project_id = pm.project_id AND e.status = 'approved'
      ) x ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY gross_profit`, params);
  return rows;
}

export async function profitabilityByClient(c, f = buildFilters()) {
  const params = [];
  const where = ['cl.archived_at IS NULL'];
  if (f.client) { params.push(f.client); where.push(`cl.id = $${params.length}`); }
  if (f.project) { params.push(f.project); where.push(`pm.project_id = $${params.length}`); }
  const { rows } = await c.query(`
    SELECT cl.id, cl.name,
           count(DISTINCT pm.project_id)::int AS projects,
           COALESCE(sum(pm.contract_value), 0) AS contracted,
           COALESCE(sum(pm.revenue_base), 0)   AS revenue,
           COALESCE(sum(pm.cost_base), 0)      AS cost,
           COALESCE(sum(pm.revenue_base), 0) - COALESCE(sum(pm.cost_base), 0) AS gross_profit
      FROM clients cl
      LEFT JOIN project_margin pm ON pm.client_id = cl.id
     WHERE ${where.join(' AND ')}
     GROUP BY cl.id, cl.name
    HAVING count(pm.project_id) > 0
     ORDER BY gross_profit DESC`, params);
  return rows;
}

export async function utilisation(c, days = 30, f = buildFilters()) {
  const params = [days];
  // The date window, if given, replaces the rolling `days` for the time join.
  const fromTo = f.from || f.to;
  if (fromTo) { params.push(f.from || '1970-01-01', f.to || '2999-12-31'); }
  const windowClause = fromTo
    ? `te.worked_on BETWEEN $${params.length - 1}::date AND $${params.length}::date`
    : `te.worked_on >= current_date - $1::int`;

  const scopeParts = [];
  if (f.client) { params.push(f.client); scopeParts.push(`p.client_id = $${params.length}`); }
  if (f.project) { params.push(f.project); scopeParts.push(`p.id = $${params.length}`); }
  const projClause = scopeParts.length
    ? ` AND te.project_id IN (SELECT p.id FROM projects p WHERE ${scopeParts.join(' AND ')})` : '';
  let personClause = '';
  if (f.user) { params.push(f.user); personClause = ` AND ms.user_id = $${params.length}`; }

  const { rows } = await c.query(`
    SELECT u.full_name, ms.role, ms.weekly_hours,
           COALESCE(t.hours, 0)     AS hours,
           COALESCE(t.billable, 0)  AS billable,
           COALESCE(t.non_billable, 0) AS non_billable,
           ms.weekly_hours * $1 / 7.0 AS capacity,
           CASE WHEN ms.weekly_hours > 0
                THEN COALESCE(t.billable, 0) / (ms.weekly_hours * $1 / 7.0) END AS utilisation,
           COALESCE(t.value, 0) - COALESCE(t.cost, 0) AS contributed
      FROM memberships ms
      JOIN users u ON u.id = ms.user_id
      LEFT JOIN LATERAL (
        SELECT sum(hours) hours,
               sum(hours) FILTER (WHERE billable) billable,
               sum(hours) FILTER (WHERE NOT billable) non_billable,
               sum(cost_base) cost, sum(value_base) value
          FROM time_entries te
         WHERE te.user_id = ms.user_id AND ${windowClause}${projClause}
      ) t ON true
     WHERE ms.is_active AND ms.role <> 'client'${personClause}
     ORDER BY utilisation DESC NULLS LAST`, params);
  return rows;
}

export async function invoiceAging(c, f = buildFilters()) {
  // The bucket is computed in a subquery rather than aliased inline: an output
  // alias is not in scope inside ORDER BY's expression, so array_position()
  // cannot see it. Explicit and portable beats clever here.
  const { rows } = await c.query(`
    SELECT bucket, count(*)::int AS count, sum(balance) AS outstanding
      FROM (
        SELECT CASE WHEN status = 'paid' THEN 'paid'
                    WHEN due_on >= current_date THEN 'current'
                    WHEN current_date - due_on <= 30 THEN '1-30 days'
                    WHEN current_date - due_on <= 60 THEN '31-60 days'
                    ELSE '60+ days' END AS bucket,
               total - amount_paid AS balance
          FROM invoices i WHERE i.status <> 'void'
            ${f.client ? 'AND i.client_id = $1' : ''}
            ${f.project ? `AND i.project_id = $${f.client ? 2 : 1}` : ''}
      ) b
     GROUP BY bucket
     ORDER BY array_position(
       ARRAY['current','1-30 days','31-60 days','60+ days','paid'], bucket)`,
    [f.client, f.project].filter(Boolean));
  return rows;
}
