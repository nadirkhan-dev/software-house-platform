import './env.js';   // must be first: src/auth.js calls requireSecret() at module scope
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asUser, asOwner } from './db.js';
import { login, issueCookie, clearCookie, session, requireAuth, requirePlatformAdmin,
         permissions, redact, PROJECT_FIELDS, FINANCE } from './auth.js';
import { securityHeaders, csrf, loginLimiter, apiLimiter, writeLimiter } from './security.js';
import { validate, schemas } from './validate.js';
import { projectMargins, portfolio, alerts, derive } from './margin.js';
import { billable, draftInvoice } from './invoicing.js';
import { routes as moduleRoutes } from './routes.js';
import { platformRoutes } from './platform-routes.js';
import { notifyFinance } from './notifications.js';
import { mondayOf } from './dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
// A 100kb JSON body is generous for this API and stops a trivial memory DoS.
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// Asana redirects the browser here with no cookie of ours and no header it
// could set. The signed `state` parameter is the CSRF defence for that one
// route, checked inside the handler.
app.use((req, res, next) =>
  req.path === '/api/integrations/asana/callback' ? next() : csrf(req, res, next));
app.use(session);

const perms = req => permissions(req.ctx.role);
// Async handlers that throw should return 500, not hang the socket forever.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ auth */

app.post('/api/login', loginLimiter, validate(schemas.login), wrap(async (req, res) => {
  const { email, password } = req.body;
  const user = await login(email, password);
  if (!user) return res.status(401).json({ error: 'That email and password do not match' });
  issueCookie(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
  res.json({
    user: publicUser(req.ctx),
    permissions: req.ctx.tenantId ? perms(req) : null,
    isPlatformAdmin: !!req.ctx.is_platform_admin,
    csrfToken: res.locals.csrfToken,
  });
});

/* -------------------------------------------------------------- platform */
/* Deliberately thin. Platform staff provision and bill tenants; they do not
   read tenant business data. There is no endpoint here that returns a client,
   a project, an invoice or a person's rate — and because these accounts never
   receive a tenant context, RLS would return nothing even if one were added by
   mistake. */

app.get('/api/platform/tenants', requirePlatformAdmin, wrap(async (_req, res) => {
  const { rows } = await asOwner(c => c.query(`
    SELECT t.id, t.name, t.slug, t.plan, t.seats_included, t.created_at,
           (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.is_active) AS seats_used
      FROM tenants t WHERE t.deleted_at IS NULL ORDER BY t.created_at`));
  res.json({ tenants: rows });
}));

const publicUser = u => ({
  id: u.user_id, name: u.full_name, email: u.email, role: u.role,
  tenant: u.tenant_name, homeCurrency: u.home_currency, baseCurrency: u.base_currency,
});

app.get('/api/integrations/asana/callback', apiLimiter,
  (req, res, next) => platformRoutes.handle(
    Object.assign(req, { url: '/integrations/asana/callback' }), res, next));

app.use('/api', apiLimiter, requireAuth);

/* ------------------------------------------------------------- dashboard */

app.get('/api/dashboard', wrap(async (req, res) => {
  const p = perms(req);
  const data = await asUser(req.ctx, async c => {
    const rows = await projectMargins(c);

    // Sequential, not Promise.all: these all share one pooled client inside one
    // transaction, and a pg client cannot run two queries at once.
    const absorbed = p.seesCost ? (await c.query(`
        SELECT co.project_id, co.title, co.est_hours, p.name AS project_name
          FROM change_orders co JOIN projects p ON p.id = co.project_id
         WHERE co.status = 'absorbed'`)).rows : [];

    const overdue = p.seesRevenue ? (await c.query(`
        SELECT i.id, i.number, i.total, i.project_id, cl.name AS client_name,
               current_date - i.due_on AS days_overdue,
               COALESCE((SELECT sum(hours) FROM time_entries te
                          WHERE te.project_id = i.project_id AND te.worked_on > i.due_on), 0) AS hours_since
          FROM invoices i JOIN clients cl ON cl.id = i.client_id
         WHERE i.status <> 'paid' AND i.due_on < current_date`)).rows : [];

    const fx = p.seesCost ? await fxMove(c) : null;

    // Hours are scoped like everything else: your own if you are a developer.
    const hours = (await c.query(
      p.seesRevenue
        ? `SELECT COALESCE(sum(hours),0) h, COALESCE(sum(hours) FILTER (WHERE billable),0) b FROM time_entries`
        : `SELECT COALESCE(sum(hours),0) h, COALESCE(sum(hours) FILTER (WHERE billable),0) b
             FROM time_entries WHERE user_id = $1`,
      p.seesRevenue ? [] : [req.ctx.userId])).rows[0];

    const outstanding = p.seesRevenue ? (await c.query(
      `SELECT COALESCE(sum(total),0) t,
              COALESCE(sum(total) FILTER (WHERE due_on < current_date),0) o
         FROM invoices WHERE status <> 'paid'`)).rows[0] : { t: null, o: null };

    return {
      portfolio: redact(portfolio(rows), p, PROJECT_FIELDS),
      hours: { total: hours.h, billable: hours.b, scope: p.seesRevenue ? 'company' : 'own' },
      outstanding: outstanding.t, overdue: outstanding.o,
      projects: rows.map(r => redact(r, p, PROJECT_FIELDS)),
      alerts: alerts(rows, { absorbed, overdue, fx }, p),
      fx,
    };
  });
  res.json(data);
}));

async function fxMove(c) {
  const { rows } = await c.query(`
    SELECT (SELECT units_per_base FROM fx_rates WHERE home_ccy='PKR' AND base_ccy='USD'
             ORDER BY effective_date DESC LIMIT 1) AS today,
           (SELECT units_per_base FROM fx_rates WHERE home_ccy='PKR' AND base_ccy='USD'
             AND effective_date <= current_date - 30 ORDER BY effective_date DESC LIMIT 1) AS ago`);
  const { today, ago } = rows[0];
  if (!today || !ago) return null;
  return { today, ago, change: today - ago };
}

/* -------------------------------------------------------------- projects */

app.get('/api/projects', wrap(async (req, res) => {
  const p = perms(req);
  const rows = await asUser(req.ctx, c => projectMargins(c));
  res.json({ projects: rows.map(r => redact(r, p, PROJECT_FIELDS)) });
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = perms(req);
  const out = await asUser(req.ctx, async c => {
    const { rows } = await c.query(`
      SELECT pm.*, pr.starts_on, pr.due_on, pr.status, cl.name AS client_name, cl.country
        FROM project_margin pm
        JOIN projects pr ON pr.id = pm.project_id
        JOIN clients cl ON cl.id = pm.client_id
       WHERE pm.project_id = $1`, [req.params.id]);
    // RLS already filtered this. No row means not visible, which is a 404.
    if (!rows[0]) return null;
    const project = derive(rows[0]);

    // One client, one transaction: these run in sequence.
    const milestones = (await c.query(`SELECT id, name, position, value_amount, due_on, approved_at
                 FROM milestones WHERE project_id=$1 ORDER BY position`, [req.params.id])).rows;
    const changeOrders = (await c.query(`SELECT id, title, est_hours, price_amount, status, created_at
                 FROM change_orders WHERE project_id=$1 ORDER BY created_at DESC`, [req.params.id])).rows;
    const invoices = (await c.query(`
      SELECT i.id, i.number, i.total, i.amount_paid, i.total - i.amount_paid AS balance,
             i.issued_on, i.due_on, i.status,
             (SELECT method FROM payments p WHERE p.invoice_id = i.id ORDER BY received_on DESC LIMIT 1) AS last_method
        FROM invoices i WHERE i.project_id=$1 ORDER BY i.issued_on DESC`, [req.params.id])).rows;
    const breakdown = p.seesCost ? (await c.query(`
        SELECT u.full_name, m.role, sum(te.hours) hours,
               sum(te.cost_base) cost, sum(te.value_base) value
          FROM time_entries te
          JOIN users u ON u.id = te.user_id
          JOIN memberships m ON m.user_id = te.user_id AND m.tenant_id = te.tenant_id
         WHERE te.project_id = $1
         GROUP BY u.full_name, m.role ORDER BY cost DESC`, [req.params.id])).rows : [];
    const fxRange = p.seesCost ? (await c.query(
        `SELECT min(fx_rate) lo, max(fx_rate) hi, count(DISTINCT worked_on) days
           FROM time_entries WHERE project_id=$1`, [req.params.id])).rows[0] : null;
    return { project: redact(project, p, PROJECT_FIELDS), milestones, changeOrders, invoices, breakdown, fxRange };
  });
  if (!out) return res.status(404).json({ error: 'No such project, or it is not yours to see' });
  res.json(out);
}));

/* ------------------------------------------------------------------ time */

app.get('/api/time', wrap(async (req, res) => {
  const start = req.query.start || mondayOf(new Date());
  const out = await asUser(req.ctx, async c => {
    const entries = await c.query(`
      SELECT te.id, te.project_id, te.worked_on, te.hours, te.billable, te.category,
             te.locked_at IS NOT NULL AS locked, p.name AS project_name, cl.name AS client_name
        FROM time_entries te
        JOIN projects p ON p.id = te.project_id
        JOIN clients cl ON cl.id = p.client_id
       WHERE te.user_id = $1 AND te.worked_on >= $2::date AND te.worked_on < $2::date + 7
       ORDER BY te.worked_on`, [req.ctx.userId, start]);
    const projects = await c.query(`
      SELECT p.id, p.name, cl.name AS client_name
        FROM projects p JOIN clients cl ON cl.id = p.client_id
        JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1 AND p.status = 'active' ORDER BY p.name`, [req.ctx.userId]);
    const week = await c.query(`
      SELECT COALESCE(sum(hours),0) hours,
             COALESCE(sum(cost_home),0) cost_home,
             COALESCE(sum(cost_base),0) cost_base,
             COALESCE(sum(value_base),0) value_base
        FROM time_entries
       WHERE user_id=$1 AND worked_on >= $2::date AND worked_on < $2::date + 7`, [req.ctx.userId, start]);
    return { start, entries: entries.rows, projects: projects.rows, totals: week.rows[0] };
  });
  const p = perms(req);
  if (!p.seesCost) { delete out.totals.cost_home; delete out.totals.cost_base; }
  if (!p.seesRevenue) delete out.totals.value_base;
  res.json(out);
}));

app.put('/api/time', writeLimiter, validate(schemas.timeEntry), wrap(async (req, res) => {
  const { project_id, worked_on, hours: h } = req.body;

  try {
    const out = await asUser(req.ctx, async c => {
      const existing = await c.query(
        `SELECT id, locked_at FROM time_entries
          WHERE user_id=$1 AND project_id=$2 AND worked_on=$3 LIMIT 1`,
        [req.ctx.userId, project_id, worked_on]);

      if (existing.rows[0]?.locked_at) return { locked: true };

      if (h === 0) {
        if (existing.rows[0]) await c.query('DELETE FROM time_entries WHERE id=$1', [existing.rows[0].id]);
        return { hours: 0 };
      }
      if (existing.rows[0]) {
        const { rows } = await c.query(
          'UPDATE time_entries SET hours=$1 WHERE id=$2 RETURNING id, hours', [h, existing.rows[0].id]);
        return rows[0];
      }
      // The insert trigger freezes the rate card and FX rate. The client never
      // sends them, so it cannot get them wrong or backdate them favourably.
      const { rows } = await c.query(`
        INSERT INTO time_entries (tenant_id, project_id, user_id, worked_on, hours, billable, category)
        VALUES ($1,$2,$3,$4,$5,true,'delivery') RETURNING id, hours`,
        [req.ctx.tenantId, project_id, req.ctx.userId, worked_on, h]);
      return rows[0];
    });
    if (out.locked) return res.status(409).json({ error: 'That time is already invoiced and cannot be changed' });
    res.json(out);
  } catch (e) {
    if (/No rate card/.test(e.message)) return res.status(422).json({ error: 'You have no rate card covering that date. Ask an owner to set one.' });
    if (/No PKR/.test(e.message)) return res.status(422).json({ error: 'No exchange rate is recorded for that date yet.' });
    throw e;
  }
}));

/* -------------------------------------------------------------- invoices */

app.get('/api/invoices', wrap(async (req, res) => {
  if (!perms(req).seesRevenue && !perms(req).isClient)
    return res.status(403).json({ error: 'Invoices are not visible at your permission level' });
  const out = await asUser(req.ctx, async c => {
    const invoices = await c.query(`
      SELECT i.id, i.number, i.total, i.currency, i.issued_on, i.due_on, i.status,
             i.amount_paid, i.total - i.amount_paid AS balance,
             (SELECT method FROM payments pm WHERE pm.invoice_id = i.id
               ORDER BY received_on DESC LIMIT 1) AS last_method,
             i.project_id, p.name AS project_name, cl.name AS client_name,
             current_date - i.due_on AS days_overdue
        FROM invoices i
        JOIN clients cl ON cl.id = i.client_id
        LEFT JOIN projects p ON p.id = i.project_id
       ORDER BY i.issued_on DESC`);
    // Delivered but not yet billed. Computed from what is genuinely invoiceable
    // — approved milestones, or time no invoice has claimed — rather than from
    // revenue minus invoices, which counts work the client has not signed off.
    const projects = await c.query(`SELECT id FROM projects WHERE status = 'active'`);
    const unbilled = [];
    for (const { id } of projects.rows) {
      const b = await billable(c, id);
      if (b && b.total > 0) unbilled.push({
        project_id: id, name: b.project.name, billing_type: b.project.billing_type,
        amount: b.total, lines: b.lines.length,
      });
    }
    return { invoices: invoices.rows, unbilled };
  });
  res.json(out);
}));

/* ------------------------------------------------------------------ team */

app.get('/api/team', wrap(async (req, res) => {
  const p = perms(req);
  if (!p.seesRevenue) return res.status(403).json({ error: 'Team rates are not visible at your permission level' });
  const rows = await asUser(req.ctx, async c => (await c.query(`
    SELECT u.full_name, ms.role, ms.employment, ms.weekly_hours,
           rc.cost_amount, rc.overhead_multiplier, rc.bill_rate,
           rc.cost_amount * rc.overhead_multiplier / 176 AS cost_hour_home,
           COALESCE(t.hours,0) hours, COALESCE(t.billable,0) billable,
           COALESCE(t.contributed,0) contributed,
           CASE WHEN ms.weekly_hours > 0
                THEN COALESCE(t.billable,0) / (ms.weekly_hours * 30 / 7.0) END AS utilisation
      FROM memberships ms
      JOIN users u ON u.id = ms.user_id
      LEFT JOIN rate_cards rc ON rc.user_id = ms.user_id AND rc.project_id IS NULL AND rc.valid_to IS NULL
      LEFT JOIN LATERAL (
        SELECT sum(hours) hours, sum(hours) FILTER (WHERE billable) billable,
               sum(value_base) - sum(cost_base) contributed
          FROM time_entries te WHERE te.user_id = ms.user_id AND te.worked_on >= current_date - 30
      ) t ON true
     WHERE ms.is_active AND ms.role <> 'client'
     ORDER BY t.hours DESC NULLS LAST`)).rows);

  // Cost rates are the most sensitive column in the product. RLS already hides
  // other people's rate cards from anyone but an owner; this strips whatever
  // did come back for a role that should not render it.
  res.json({
    team: rows.map(r => p.seesCost ? r
      : { ...r, cost_amount: undefined, cost_hour_home: undefined, contributed: undefined, overhead_multiplier: undefined }),
  });
}));

/* ------------------------------------------------------- raising invoices */

app.post('/api/invoices', writeLimiter, validate(schemas.draftInvoice), wrap(async (req, res) => {
  if (!perms(req).canInvoice)
    return res.status(403).json({ error: 'Only an admin or finance user can raise an invoice' });
  const { project_id, term_days } = req.body;

  const out = await asUser(req.ctx, c => draftInvoice(c, req.ctx.tenantId, project_id, { termDays: term_days || 30 }));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
}));

// Sending and settling now live in routes.js: `pay` as a bare status flip is
// gone, because an invoice may only become paid when payment records support it.

/* ---------------------------------------------------- milestone sign-off */

app.post('/api/milestones/:id/approve', writeLimiter, wrap(async (req, res) => {
  // The client signs off; the team cannot sign off on the client's behalf.
  // This timestamp is what settles an argument six months later, so it records
  // who and from where, not just when.
  if (!perms(req).canApproveMilestone)
    return res.status(403).json({ error: 'Only the client can approve a milestone' });

  const out = await asUser(req.ctx, async c => {
    const { rows } = await c.query(
      `SELECT id, name, approved_at FROM milestones WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return { error: 'No such milestone, or it is not yours to approve', status: 404 };
    if (rows[0].approved_at) return { error: 'That milestone is already signed off', status: 409 };
    const { rows: up } = await c.query(`
      UPDATE milestones SET approved_at = now(), approved_by = $2, approved_ip = $3
       WHERE id = $1 RETURNING id, name, approved_at, project_id`,
      [req.params.id, req.ctx.userId, req.ip || null]);
    // Finance is the audience: an approved milestone is money that can now be
    // invoiced, and it sitting unbilled is the common failure.
    const { rows: ctx } = await c.query(
      `SELECT cl.name AS client FROM projects p JOIN clients cl ON cl.id = p.client_id
        WHERE p.id = $1`, [up[0].project_id]);
    await notifyFinance(c, req.ctx, 'milestone_approved',
      { name: up[0].name, client: ctx[0]?.client || 'The client' });
    return { milestone: up[0] };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
}));

/* -------------------------------------------------------------- test aid */
/* Exposes the in-memory outbox so the suite can assert on what was actually
   queued for delivery. Mounted only under NODE_ENV=test — it does not exist in
   development or production, so it cannot become an information leak. */
if (process.env.NODE_ENV === 'test') {
  const { outbox, clearOutbox } = await import('./email.js');
  app.get('/api/test/outbox', (_req, res) => res.json({
    messages: outbox.map(m => ({
      subject: m.subject, bcc: Array.isArray(m.bcc) ? m.bcc.length : 0,
      html: m.html ?? '', text: m.text ?? '',
    })),
  }));
  app.delete('/api/test/outbox', (_req, res) => { clearOutbox(); res.json({ cleared: true }); });
}

/* ----------------------------------------------------------------- serve */

app.use('/api', moduleRoutes);
app.use('/api', platformRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
/**
 * SPA fallback. Deliberately narrow: an unmatched /api path must return a JSON
 * 404, not index.html — a client that receives HTML where it expected JSON
 * fails with a parse error that tells nobody anything useful.
 */
app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/**
 * Postgres error codes that mean "the caller asked for something they are not
 * allowed to have", not "the server is broken".
 *
 * 42501 is what row-level security raises when a WITH CHECK fails — for
 * example writing into another tenant. Left unhandled it surfaces as a 500 with
 * a stack trace in the log, which both looks like an outage and tells an
 * attacker their probe reached the database. Answer 404: the row they aimed at
 * does not exist as far as they are concerned.
 */
const PG_DENIED = new Set(['42501']);
const PG_CONFLICT = new Set(['23505']);              // unique_violation
const PG_BAD_REF  = new Set(['23503', '23514']);     // foreign key, check constraint

app.use((err, req, res, _next) => {
  if (PG_DENIED.has(err.code)) {
    console.warn(`denied: ${req.method} ${req.path} by ${req.ctx?.userId || 'anon'} (${err.code})`);
    return res.status(404).json({ error: 'Not found, or not yours to change' });
  }
  if (PG_CONFLICT.has(err.code)) return res.status(409).json({ error: 'That already exists' });
  if (PG_BAD_REF.has(err.code)) return res.status(422).json({ error: 'That refers to something invalid' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request was too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Malformed JSON' });

  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

const PORT = process.env.PORT || 3000;
/* Two different things once shared NODE_ENV=test: whether to bind a port, and
   which mail transport to use. That meant switching the mail transport silently
   stopped the server listening. They are separate concerns and now have
   separate switches — NO_LISTEN is for importing this file in a unit test. */
if (process.env.NO_LISTEN !== '1') {
  app.listen(PORT, () => console.log(`Marginly running on http://localhost:${PORT}`));
}

export default app;
