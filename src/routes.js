import { Router } from 'express';
import { asUser } from './db.js';
import { permissions } from './auth.js';
import { validate, schemas } from './validate.js';
import { writeLimiter } from './security.js';
import { listPayments, invoiceWithBalance, recordPayment, voidInvoice, sendInvoice, markViewed } from './payments.js';
import { invoicePdf, quotePdf } from './pdf.js';
import { convertLead, createQuote, getQuote, sendQuote, decideQuote, projectFromQuote, markQuoteViewed } from './sales.js';
import { notifyFinance, notifySales, notifyClient, notifyUser, listNotifications, markRead } from './notifications.js';
import { search, revenueByMonth, profitabilityByProject, profitabilityByClient, utilisation, invoiceAging, buildFilters } from './reports.js';

export const routes = Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const perms = req => permissions(req.ctx.role);

/** Guards a route on a named permission, so the check reads like the rule. */
const need = flag => (req, res, next) =>
  perms(req)[flag] ? next() : res.status(403).json({ error: 'Not permitted at your access level' });

/* ========================================================== PAYMENTS ==== */

routes.get('/invoices/:id/payments', wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => {
    const inv = await invoiceWithBalance(c, req.params.id);
    if (!inv) return null;
    return { invoice: inv, payments: await listPayments(c, req.params.id) };
  });
  if (!out) return res.status(404).json({ error: 'No such invoice' });
  // A client may see what they have paid, never what the work cost to produce.
  res.json(out);
}));

routes.post('/invoices/:id/payments', writeLimiter, need('canInvoice'),
  validate(schemas.payment), wrap(async (req, res) => {
    const out = await asUser(req.ctx, async c => {
      const r = await recordPayment(c, req.ctx.tenantId, req.ctx.userId, req.params.id, req.body);
      if (r.error) return r;
      await notifyFinance(c, req.ctx, 'payment_received', {
        number: r.invoice.number,
        amount: '$' + Number(r.payment.amount).toLocaleString('en-US'),
      });
      return r;
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json(out);
  }));

routes.post('/invoices/:id/void', writeLimiter, need('canInvoice'),
  validate(schemas.voidInvoice), wrap(async (req, res) => {
    const out = await asUser(req.ctx, c => voidInvoice(c, req.params.id, req.body.reason));
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  }));

routes.post('/invoices/:id/send', writeLimiter, need('canInvoice'), wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => {
    const r = await sendInvoice(c, req.params.id);
    if (r.error) return r;
    const inv = await invoiceWithBalance(c, req.params.id);
    await notifyClient(c, req.ctx, inv.client_id, 'invoice_sent', { number: inv.number });
    return r;
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
}));

/* =============================================================== PDF ==== */

async function tenantHeader(c, tenantId) {
  const { rows } = await c.query(
    `SELECT name, home_currency, base_currency FROM tenants WHERE id = $1`, [tenantId]);
  return rows[0] || { name: 'Agency' };
}

routes.get('/invoices/:id/pdf', wrap(async (req, res) => {
  const data = await asUser(req.ctx, async c => {
    const inv = await invoiceWithBalance(c, req.params.id);
    if (!inv) return null;
    const { rows: lines } = await c.query(
      `SELECT description, quantity, unit_amount, amount FROM invoice_lines
        WHERE invoice_id = $1 ORDER BY id`, [req.params.id]);
    const { rows: cl } = await c.query('SELECT name, country FROM clients WHERE id=$1', [inv.client_id]);
    // A client opening the PDF is the closest thing to proof of receipt we have.
    if (perms(req).isClient) await markViewed(c, req.params.id);
    return { tenant: await tenantHeader(c, req.ctx.tenantId), invoice: inv, client: cl[0], lines,
             payments: await listPayments(c, req.params.id) };
  });
  if (!data) return res.status(404).json({ error: 'No such invoice' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${data.invoice.number}.pdf"`);
  invoicePdf(data).pipe(res);
}));

routes.get('/quotes/:id/pdf', wrap(async (req, res) => {
  const data = await asUser(req.ctx, async c => {
    const q = await getQuote(c, req.params.id);
    if (!q) return null;
    if (perms(req).isClient) await markQuoteViewed(c, req.params.id);
    return { tenant: await tenantHeader(c, req.ctx.tenantId), quote: q,
             client: { name: q.client_name, country: q.country }, lines: q.lines };
  });
  if (!data) return res.status(404).json({ error: 'No such quote' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${data.quote.number}.pdf"`);
  quotePdf(data).pipe(res);
}));

/* ============================================================= TASKS ==== */

routes.get('/tasks', wrap(async (req, res) => {
  const { project_id, assignee, status } = req.query;
  const out = await asUser(req.ctx, async c => {
    const where = [], args = [];
    if (project_id) { args.push(project_id); where.push(`t.project_id = $${args.length}`); }
    if (assignee)   { args.push(assignee);   where.push(`t.assignee_id = $${args.length}`); }
    if (status)     { args.push(status);     where.push(`t.status = $${args.length}`); }
    const { rows } = await c.query(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.position, t.due_on,
             t.estimate_hours, t.tags, t.completed_at, t.project_id, t.milestone_id,
             p.name AS project_name, u.full_name AS assignee_name, t.assignee_id,
             COALESCE((SELECT sum(hours) FROM time_entries te WHERE te.task_id = t.id), 0) AS logged_hours
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = t.assignee_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.status, t.position, t.created_at`, args);
    return rows;
  });
  res.json({ tasks: out });
}));

routes.post('/tasks', writeLimiter, validate(schemas.task), wrap(async (req, res) => {
  if (perms(req).isClient) return res.status(403).json({ error: 'Clients cannot create tasks' });
  const b = req.body;
  const out = await asUser(req.ctx, async c => {
    const { rows } = await c.query(`
      INSERT INTO tasks (tenant_id, project_id, milestone_id, title, description, assignee_id,
                         reporter_id, status, priority, estimate_hours, due_on, tags,
                         position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
              COALESCE((SELECT max(position)+1 FROM tasks WHERE project_id=$2 AND status=$8), 0))
      RETURNING id, title, status, priority, position`,
      [req.ctx.tenantId, b.project_id, b.milestone_id || null, b.title, b.description || null,
       b.assignee_id || null, req.ctx.userId, b.status || 'todo', b.priority || 'medium',
       b.estimate_hours ?? null, b.due_on || null, b.tags || []]);
    if (b.assignee_id) await notifyUser(c, req.ctx, b.assignee_id, 'task_assigned', { title: b.title });
    return rows[0];
  });
  res.status(201).json({ task: out });
}));

routes.patch('/tasks/:id', writeLimiter, validate(schemas.taskPatch), wrap(async (req, res) => {
  if (perms(req).isClient) return res.status(403).json({ error: 'Clients cannot change tasks' });
  const fields = Object.keys(req.body);
  const out = await asUser(req.ctx, async c => {
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    // Completion time is derived from the status, never sent by the caller.
    // It reuses the status placeholder rather than appending a second copy of
    // the same value — doing both is how the parameter count drifts.
    if (req.body.status) {
      const statusIdx = fields.indexOf('status') + 2;
      sets.push(`completed_at = CASE WHEN $${statusIdx} = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END`);
    }
    const args = [req.params.id, ...fields.map(f => req.body[f])];
    const { rows } = await c.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1
        RETURNING id, title, status, priority, position, assignee_id, due_on, completed_at`, args);
    return rows[0];
  });
  if (!out) return res.status(404).json({ error: 'No such task' });
  res.json({ task: out });
}));

/* ========================================================== EXPENSES ==== */

routes.get('/expenses', wrap(async (req, res) => {
  if (perms(req).isClient) return res.status(403).json({ error: 'Not permitted at your access level' });
  const out = await asUser(req.ctx, async c => (await c.query(`
    SELECT e.id, e.incurred_on, e.description, e.category, e.amount, e.currency,
           e.billable, e.status, e.project_id, p.name AS project_name,
           u.full_name AS submitted_by, e.amount / e.fx_rate AS amount_base
      FROM expenses e
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN users u ON u.id = e.submitted_by
     ORDER BY e.incurred_on DESC`)).rows);
  res.json({ expenses: out });
}));

routes.post('/expenses', writeLimiter, validate(schemas.expense), wrap(async (req, res) => {
  if (perms(req).isClient) return res.status(403).json({ error: 'Not permitted at your access level' });
  const b = req.body;
  const out = await asUser(req.ctx, async c => {
    // Frozen on the incurred date, exactly like time entries — a claim filed in
    // August for a June cost converts at June's rate.
    const { rows: fx } = await c.query(
      `SELECT CASE WHEN $1 = (SELECT base_currency FROM tenants WHERE id=$2) THEN 1
                   ELSE fx_on($1, (SELECT base_currency FROM tenants WHERE id=$2), $3::date) END AS r`,
      [b.currency, req.ctx.tenantId, b.incurred_on]);
    if (!fx[0].r) return { error: 'No exchange rate recorded for that date', status: 422 };

    const { rows } = await c.query(`
      INSERT INTO expenses (tenant_id, project_id, incurred_on, description, category,
                            amount, currency, fx_rate, billable, status, submitted_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10)
      RETURNING id, description, amount, status`,
      [req.ctx.tenantId, b.project_id || null, b.incurred_on, b.description, b.category,
       b.amount, b.currency, fx[0].r, b.billable ?? false, req.ctx.userId]);
    await notifyFinance(c, req.ctx, 'expense_submitted', { description: b.description });
    return { expense: rows[0] };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
}));

routes.post('/expenses/:id/:action(approve|reject)', writeLimiter, need('canInvoice'),
  wrap(async (req, res) => {
    const status = req.params.action === 'approve' ? 'approved' : 'rejected';
    const out = await asUser(req.ctx, async c => (await c.query(`
      UPDATE expenses SET status=$2, approved_by=$3, approved_at=now()
       WHERE id=$1 AND status = 'submitted'
       RETURNING id, status`, [req.params.id, status, req.ctx.userId])).rows[0]);
    if (!out) return res.status(409).json({ error: 'That expense is not awaiting a decision' });
    res.json({ expense: out });
  }));

/* ============================================================= LEADS ==== */

const salesRoles = ['admin', 'sales', 'pm'];
const needSales = (req, res, next) =>
  salesRoles.includes(req.ctx.role) ? next() : res.status(403).json({ error: 'Not permitted at your access level' });

routes.get('/leads', needSales, wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => (await c.query(`
    SELECT l.*, u.full_name AS owner_name, c.name AS converted_client
      FROM leads l
      LEFT JOIN users u ON u.id = l.owner_id
      LEFT JOIN clients c ON c.id = l.client_id
     ORDER BY array_position(ARRAY['new','qualified','proposal','negotiation','won','lost'], l.stage),
              l.updated_at DESC`)).rows);
  res.json({ leads: out });
}));

routes.post('/leads', writeLimiter, needSales, validate(schemas.lead), wrap(async (req, res) => {
  const b = req.body;
  const out = await asUser(req.ctx, async c => (await c.query(`
    INSERT INTO leads (tenant_id, company, contact_name, email, phone, source, est_value,
                       probability, stage, owner_id, notes, next_follow_up)
    VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id, company, stage, est_value`,
    [req.ctx.tenantId, b.company, b.contact_name || null, b.email || '', b.phone || null,
     b.source || 'inbound', b.est_value ?? 0, b.probability ?? 25, b.stage || 'new',
     req.ctx.userId, b.notes || null, b.next_follow_up || null])).rows[0]);
  res.status(201).json({ lead: out });
}));

routes.patch('/leads/:id', writeLimiter, needSales, validate(schemas.lead.partial()),
  wrap(async (req, res) => {
    const fields = Object.keys(req.body);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change' });
    const out = await asUser(req.ctx, async c => (await c.query(
      `UPDATE leads SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING id, company, stage, probability, est_value`,
      [req.params.id, ...fields.map(f => req.body[f])])).rows[0]);
    if (!out) return res.status(404).json({ error: 'No such lead' });
    res.json({ lead: out });
  }));

routes.post('/leads/:id/convert', writeLimiter, needSales, wrap(async (req, res) => {
  const out = await asUser(req.ctx, c => convertLead(c, req.ctx.tenantId, req.params.id));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
}));

/* ============================================================ QUOTES ==== */

routes.get('/quotes', wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => (await c.query(`
    SELECT q.id, q.number, q.title, q.status, q.total, q.currency, q.expires_on,
           q.sent_at, q.decided_at, q.project_id, cl.name AS client_name
      FROM quotes q JOIN clients cl ON cl.id = q.client_id
     ORDER BY q.created_at DESC`)).rows);
  res.json({ quotes: out });
}));

routes.get('/quotes/:id', wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => {
    const q = await getQuote(c, req.params.id);
    if (q && perms(req).isClient) await markQuoteViewed(c, req.params.id);
    return q;
  });
  if (!out) return res.status(404).json({ error: 'No such quote' });
  res.json({ quote: out });
}));

routes.post('/quotes', writeLimiter, needSales, validate(schemas.quote), wrap(async (req, res) => {
  const out = await asUser(req.ctx, c => createQuote(c, req.ctx.tenantId, req.ctx.userId, req.body));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
}));

routes.post('/quotes/:id/send', writeLimiter, needSales, wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => {
    const r = await sendQuote(c, req.params.id);
    if (r.error) return r;
    const q = await getQuote(c, req.params.id);
    await notifyClient(c, req.ctx, q.client_id, 'quote_sent', { number: q.number, client: q.client_name });
    return r;
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
}));

/** The decision is the client's. Admins may record one taken over the phone. */
routes.post('/quotes/:id/decision', writeLimiter, validate(schemas.quoteDecision),
  wrap(async (req, res) => {
    if (!(perms(req).isClient || req.ctx.role === 'admin')) {
      return res.status(403).json({ error: 'Only the client can accept or decline a quote' });
    }
    const out = await asUser(req.ctx, async c => {
      const r = await decideQuote(c, req.params.id, req.body.decision, {
        userId: req.ctx.userId, ip: req.ip, reason: req.body.reason,
      });
      if (r.error) return r;
      const q = await getQuote(c, req.params.id);
      await notifySales(c, req.ctx,
        req.body.decision === 'accepted' ? 'quote_accepted' : 'quote_rejected',
        { number: q.number, client: q.client_name });
      return r;
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  }));

routes.post('/quotes/:id/project', writeLimiter, needSales, wrap(async (req, res) => {
  const out = await asUser(req.ctx, c => projectFromQuote(c, req.ctx.tenantId, req.params.id, req.body || {}));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
}));


/* ===================================================== NOTIFICATIONS ==== */

routes.get('/notifications', wrap(async (req, res) => {
  const out = await asUser(req.ctx, c => listNotifications(c, req.ctx.userId));
  res.json(out);
}));

routes.post('/notifications/read', writeLimiter, wrap(async (req, res) => {
  const n = await asUser(req.ctx, c => markRead(c, req.ctx.userId, req.body?.id || null));
  res.json({ marked: n });
}));

/* ============================================================ SEARCH ==== */

routes.get('/search', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  // Two characters is the floor: a single letter matches most of the database
  // and the result is noise rather than an answer.
  if (term.length < 2) return res.json({ results: [] });
  const results = await asUser(req.ctx, c => search(c, term, perms(req)));
  res.json({ results });
}));

/* =========================================================== REPORTS ==== */

routes.get('/reports', wrap(async (req, res) => {
  const p = perms(req);
  if (!p.seesRevenue) return res.status(403).json({ error: 'Reports are not visible at your access level' });
  const months = Math.min(24, Math.max(3, Number(req.query.months) || 12));
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));

  const f = buildFilters(req.query);

  const out = await asUser(req.ctx, async c => ({
    filters: { ...f, args: undefined },
    // The options the filter bar offers come from the same RLS-scoped
    // connection, so nobody is shown a client or colleague they cannot see.
    options: {
      clients: (await c.query(
        `SELECT id, name FROM clients WHERE archived_at IS NULL ORDER BY name`)).rows,
      projects: (await c.query(
        `SELECT p.id, p.name, p.client_id FROM projects p ORDER BY p.name`)).rows,
      team: p.seesCost ? (await c.query(
        `SELECT u.id, u.full_name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.is_active AND m.role <> 'client' ORDER BY u.full_name`)).rows : [],
    },
    revenue: await revenueByMonth(c, months, f),
    projects: await profitabilityByProject(c, f),
    clients: await profitabilityByClient(c, f),
    team: p.seesCost ? await utilisation(c, days, f) : [],
    aging: await invoiceAging(c, f),
  }));

  // Cost and margin belong to finance. A PM sees revenue, delivery and ageing.
  if (!p.seesCost) {
    out.projects = out.projects.map(({ cost_base, gross_profit, margin, expenses, ...rest }) => rest);
    out.clients = out.clients.map(({ cost, gross_profit, ...rest }) => rest);
    out.revenue = out.revenue.map(({ labour_cost, expenses, gross_profit, ...rest }) => rest);
  }
  res.json(out);
}));
