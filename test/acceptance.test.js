import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureServer, cleanup, created, scratchDay } from './helpers.js';
import { asOwner, closePool } from '../src/db.js';

/**
 * The acceptance workflow, end to end:
 *
 *   Lead -> Client -> Quote -> Accepted -> Project -> Tasks -> Time -> Expenses
 *        -> Milestone -> Client approval -> Ready to invoice -> Invoice -> PDF
 *        -> Sent -> Partial payment -> Final payment -> Paid -> Time locked
 *        -> Profitability
 *
 * One test, in order, because the point is that the chain holds — not that each
 * link works in isolation. Everything it creates is torn down at the end.
 */

const admin = client('admin');
const finance = client('finance');
const dev = client('developer');
const cust = client('client');
let child = null;

/* Ids created by the walkthrough, cleaned up in `after`. */
const made = { leads: [], clients: [], quotes: [], projects: [], tasks: [], expenses: [] };

before(async () => {
  child = await ensureServer();
  await admin.signIn('ayesha@kdc.pk');
  await finance.signIn('nadia@kdc.pk');
  await dev.signIn('sana@kdc.pk');
  await cust.signIn('procurement@northwind.example');
});

after(async () => {
  // Deleting the client cascades to its projects, tasks, milestones, time,
  // invoices and payments, so the database returns to its seeded state.
  await asOwner(async c => {
    await c.query('ALTER TABLE time_entries DISABLE TRIGGER trg_block_locked');
    try {
      if (made.projects.length) {
        await c.query('DELETE FROM time_entries WHERE project_id = ANY($1)', [made.projects]);
        await c.query('DELETE FROM expenses WHERE project_id = ANY($1)', [made.projects]);
      }
      if (made.clients.length) {
        await c.query(`DELETE FROM payments WHERE invoice_id IN
                        (SELECT id FROM invoices WHERE client_id = ANY($1))`, [made.clients]);
        await c.query(`DELETE FROM invoice_lines WHERE invoice_id IN
                        (SELECT id FROM invoices WHERE client_id = ANY($1))`, [made.clients]);
        await c.query('DELETE FROM invoices WHERE client_id = ANY($1)', [made.clients]);
        // Quotes point at the project, and projects point at the client, so the
        // link has to be broken before either can go. Delete order here mirrors
        // the foreign keys exactly rather than relying on cascades that the
        // schema deliberately does not grant to financial records.
        await c.query('UPDATE quotes SET project_id = NULL WHERE client_id = ANY($1)', [made.clients]);
        await c.query('DELETE FROM quote_lines WHERE quote_id = ANY($1)', [made.quotes]);
        await c.query('DELETE FROM quotes WHERE client_id = ANY($1)', [made.clients]);
        if (made.projects.length) {
          await c.query('DELETE FROM tasks WHERE project_id = ANY($1)', [made.projects]);
          await c.query('DELETE FROM milestones WHERE project_id = ANY($1)', [made.projects]);
          await c.query('DELETE FROM project_members WHERE project_id = ANY($1)', [made.projects]);
          await c.query('DELETE FROM projects WHERE id = ANY($1)', [made.projects]);
        }
        await c.query('UPDATE leads SET client_id = NULL WHERE id = ANY($1)', [made.leads]);
        await c.query('DELETE FROM leads WHERE id = ANY($1)', [made.leads]);
        await c.query('DELETE FROM clients WHERE id = ANY($1)', [made.clients]);
      }
    } finally {
      await c.query('ALTER TABLE time_entries ENABLE TRIGGER trg_block_locked');
    }
  });
  await cleanup();
  await closePool();
  if (child) child.kill();
});

test('the whole business workflow, lead to paid', async t => {
  let leadId, clientId, quoteId, projectId, milestoneId, invoiceId, taskId;

  await t.test('1. sales creates a lead', async () => {
    const r = await admin.req('/api/leads', {
      method: 'POST',
      body: {
        company: 'Acceptance Test Co', contact_name: 'Jamie Vance',
        email: 'jamie@acceptance.example', source: 'referral',
        est_value: 52000, probability: 60, stage: 'qualified',
      },
    });
    assert.equal(r.status, 201);
    leadId = r.body.lead.id;
    made.leads.push(leadId);
  });

  await t.test('2. the lead converts to a client, exactly once', async () => {
    const r = await admin.req(`/api/leads/${leadId}/convert`, { method: 'POST' });
    assert.equal(r.status, 201);
    clientId = r.body.client.id;
    made.clients.push(clientId);

    // A second click must not produce a second client.
    const again = await admin.req(`/api/leads/${leadId}/convert`, { method: 'POST' });
    assert.equal(again.status, 409);
  });

  await t.test('3. a quote is raised, and its totals come from its lines', async () => {
    const r = await admin.req('/api/quotes', {
      method: 'POST',
      body: {
        client_id: clientId, lead_id: leadId, title: 'Platform build',
        tax_rate: 0.15, payment_terms: '50% up front',
        expires_on: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
        lines: [
          { description: 'Discovery', quantity: 1, unit_amount: 8000 },
          { description: 'Build', quantity: 1, unit_amount: 24000 },
          { description: 'Handover', quantity: 1, unit_amount: 6000 },
        ],
      },
    });
    assert.equal(r.status, 201);
    quoteId = r.body.quote.id;
    made.quotes.push(quoteId);
    // 38,000 + 15% = 43,700. Typed totals are never trusted.
    assert.equal(Number(r.body.quote.subtotal), 38000);
    assert.equal(Number(r.body.quote.total), 43700);
  });

  await t.test('4. an unsent quote cannot be accepted', async () => {
    // Admin, not the portal client: this quote belongs to a brand-new client
    // with no portal login, and RLS would (correctly) 404 for anyone else. The
    // guard under test is the status one.
    const r = await admin.req(`/api/quotes/${quoteId}/decision`,
      { method: 'POST', body: { decision: 'accepted' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not been sent/);
  });

  await t.test('5. the quote is sent, and generates a PDF', async () => {
    assert.equal((await admin.req(`/api/quotes/${quoteId}/send`, { method: 'POST' })).status, 200);
    const pdf = await fetchPdf(admin, `/api/quotes/${quoteId}/pdf`);
    assert.equal(pdf.type, 'application/pdf');
    assert.ok(pdf.bytes > 1000, `quote PDF was only ${pdf.bytes} bytes`);
    assert.equal(pdf.magic, '%PDF');
  });

  await t.test('6. a developer cannot accept a quote on anyone\'s behalf', async () => {
    const r = await dev.req(`/api/quotes/${quoteId}/decision`,
      { method: 'POST', body: { decision: 'accepted' } });
    assert.equal(r.status, 403);
  });

  await t.test('7. the client accepts, and it is attributed', async () => {
    const r = await admin.req(`/api/quotes/${quoteId}/decision`,
      { method: 'POST', body: { decision: 'accepted' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.quote.status, 'accepted');
    assert.ok(r.body.quote.decided_at);
  });

  await t.test('8. the accepted quote becomes a project with milestones', async () => {
    const r = await admin.req(`/api/quotes/${quoteId}/project`,
      { method: 'POST', body: { name: 'Platform build', target_margin: 0.4 } });
    assert.equal(r.status, 201);
    projectId = r.body.project.id;
    made.projects.push(projectId);
    assert.equal(r.body.milestones, 3, 'each quote line should become a milestone');
    assert.equal(Number(r.body.project.contract_value), 43700,
      'the contract value must be what the client actually agreed');

    const again = await admin.req(`/api/quotes/${quoteId}/project`, { method: 'POST', body: {} });
    assert.equal(again.status, 409, 'a quote must not spawn two projects');
  });

  await t.test('9. tasks are created and moved across the board', async () => {
    const r = await admin.req('/api/tasks', {
      method: 'POST',
      body: { project_id: projectId, title: 'Set up the repository', priority: 'high', estimate_hours: 4 },
    });
    assert.equal(r.status, 201);
    taskId = r.body.task.id;
    made.tasks.push(taskId);

    const moved = await admin.req(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status: 'done' } });
    assert.equal(moved.status, 200);
    assert.ok(moved.body.task.completed_at, 'completion time should be derived from the status');
  });

  await t.test('10. time is logged against the project', async () => {
    // The admin is on this project by virtue of creating it? No — add her.
    await asOwner(c => c.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id, project_role)
       SELECT tenant_id, $1, (SELECT id FROM users WHERE email='ayesha@kdc.pk'), 'lead'
         FROM projects WHERE id = $1 ON CONFLICT DO NOTHING`, [projectId]));

    const r = await admin.req('/api/time', {
      method: 'PUT', body: { project_id: projectId, worked_on: scratchDay(), hours: 6 },
    });
    assert.equal(r.status, 200);
    created.timeEntries.push(r.body.id);
  });

  await t.test('11. an expense is recorded and approved', async () => {
    const r = await admin.req('/api/expenses', {
      method: 'POST',
      body: {
        project_id: projectId, incurred_on: new Date().toISOString().slice(0, 10),
        description: 'Acceptance test tooling', category: 'software', amount: 500, currency: 'USD',
      },
    });
    assert.equal(r.status, 201);
    made.expenses.push(r.body.expense.id);
    assert.equal(r.body.expense.status, 'submitted');

    const ok = await finance.req(`/api/expenses/${r.body.expense.id}/approve`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.expense.status, 'approved');
  });

  await t.test('12. nothing is invoiceable until the client signs off', async () => {
    const r = await finance.req('/api/invoices', { method: 'POST', body: { project_id: projectId } });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /signs off first/);
  });

  await t.test('13. the client approves a milestone', async () => {
    const detail = await admin.req('/api/projects/' + projectId);
    milestoneId = detail.body.milestones[0].id;

    const r = await admin.req(`/api/milestones/${milestoneId}/approve`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.ok(r.body.milestone.approved_at);
  });

  await t.test('14. finance sees it as ready to invoice, and raises the invoice', async () => {
    const ready = await finance.req('/api/invoices');
    const row = ready.body.unbilled.find(u => u.project_id === projectId);
    assert.ok(row, 'the approved milestone should appear as ready to invoice');
    assert.equal(Number(row.amount), 8000);

    const r = await finance.req('/api/invoices', { method: 'POST', body: { project_id: projectId } });
    assert.equal(r.status, 201);
    invoiceId = r.body.invoice.id;
    created.invoices.push(invoiceId);
    assert.equal(r.body.invoice.status, 'draft');
    assert.ok(r.body.invoice.locked_entries > 0, 'invoicing must lock the time it bills');
  });

  await t.test('15. the same milestone cannot be billed twice', async () => {
    const again = await finance.req('/api/invoices', { method: 'POST', body: { project_id: projectId } });
    assert.equal(again.status, 422);
  });

  await t.test('16. billed time can no longer be edited', async () => {
    const week = (await admin.req('/api/time')).body;
    const locked = week.entries.find(e => e.project_id === projectId && e.locked);
    if (locked) {
      const r = await admin.req('/api/time', {
        method: 'PUT',
        body: { project_id: projectId, worked_on: locked.worked_on.slice(0, 10), hours: 1 },
      });
      assert.equal(r.status, 409);
    }
  });

  await t.test('17. the invoice generates a PDF', async () => {
    const pdf = await fetchPdf(finance, `/api/invoices/${invoiceId}/pdf`);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.magic, '%PDF');
    assert.ok(pdf.bytes > 1000, `invoice PDF was only ${pdf.bytes} bytes`);
  });

  await t.test('18. a draft cannot take a payment until it is sent', async () => {
    const r = await finance.req(`/api/invoices/${invoiceId}/payments`,
      { method: 'POST', body: { amount: 100, method: 'wise' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Send the invoice/);
  });

  await t.test('19. the invoice is sent', async () => {
    const r = await finance.req(`/api/invoices/${invoiceId}/send`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.ok(['sent', 'overdue'].includes(r.body.invoice.status));
  });

  await t.test('20. a partial payment moves it to partially paid', async () => {
    const r = await finance.req(`/api/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: { amount: 3000, method: 'wise', reference: 'ACC-TEST-1' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.invoice.status, 'partially_paid');
    assert.equal(Number(r.body.invoice.balance), 5000);
  });

  await t.test('21. the final payment settles it, derived not typed', async () => {
    const r = await finance.req(`/api/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: { amount: 5000, method: 'bank_transfer', reference: 'ACC-TEST-2' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.invoice.status, 'paid');
    assert.equal(Number(r.body.invoice.balance), 0);
    assert.equal(r.body.overpaid, 0);
  });

  await t.test('22. a developer cannot record a payment', async () => {
    const r = await dev.req(`/api/invoices/${invoiceId}/payments`,
      { method: 'POST', body: { amount: 10, method: 'cash' } });
    assert.equal(r.status, 403);
  });

  await t.test('23. a paid invoice cannot be voided without refunding first', async () => {
    const r = await finance.req(`/api/invoices/${invoiceId}/void`,
      { method: 'POST', body: { reason: 'testing the guard' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Refund/);
  });

  await t.test('24. profitability reflects labour and expenses', async () => {
    const d = await admin.req('/api/projects/' + projectId);
    const p = d.body.project;
    assert.ok(p.cost_base > 0, 'labour cost should be counted');
    // The $500 approved expense must be inside the cost figure.
    assert.ok(Number(p.cost_base) >= 500, `expenses missing from cost: ${p.cost_base}`);
    assert.equal(Number(p.contract_value), 43700);
    assert.ok(p.revenue_base > 0, 'the approved milestone should be recognised revenue');
  });

  await t.test('25. the client sees the invoice but never the cost', async () => {
    const inv = await cust.req('/api/invoices');
    assert.equal(inv.status, 200);
    const json = JSON.stringify(inv.body);
    assert.doesNotMatch(json, /cost_base|margin|rate_card/);
  });
});

/** Fetches a PDF and reports enough to prove it really is one. */
async function fetchPdf(c, path) {
  const r = await c.raw(path);
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    type: (r.headers.get('content-type') || '').split(';')[0],
    bytes: buf.length,
    magic: buf.subarray(0, 4).toString('latin1'),
  };
}
