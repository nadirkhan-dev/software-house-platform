/**
 * Invoicing — the last link in quote-to-cash.
 *
 * Two rules do most of the work here:
 *
 *  1. You can only bill what the client has signed off. On a fixed bid or a
 *     retainer that means approved milestones; on an hourly job it means
 *     billable time that no invoice has claimed yet.
 *
 *  2. Whatever an invoice bills gets locked. A timesheet that can still be
 *     edited after the client has paid for it is a dispute waiting to happen,
 *     and it quietly rewrites the margin history the whole product rests on.
 */

/** Next number for this tenant, taken under a row lock so two people invoicing
 *  at the same moment cannot mint the same one. */
async function nextNumber(c, tenantId) {
  const { rows } = await c.query(
    `UPDATE tenants SET next_invoice_no = next_invoice_no + 1
      WHERE id = $1 RETURNING next_invoice_no - 1 AS n`, [tenantId]);
  return 'INV-' + String(rows[0].n).padStart(4, '0');
}

/** What is billable on this project right now, without writing anything. */
export async function billable(c, projectId) {
  const { rows: pr } = await c.query(
    `SELECT id, name, billing_type, currency FROM projects WHERE id = $1`, [projectId]);
  const project = pr[0];
  if (!project) return null;

  if (project.billing_type === 'hourly') {
    const { rows } = await c.query(`
      SELECT u.full_name, count(*)::int entries, sum(te.hours) hours, sum(te.value_base) amount
        FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.project_id = $1 AND te.billable AND te.invoice_id IS NULL
       GROUP BY u.full_name ORDER BY amount DESC`, [projectId]);
    return {
      project,
      lines: rows.map(r => ({
        description: `${r.full_name} — ${(+r.hours).toFixed(1)} hours`,
        quantity: +(+r.hours).toFixed(2),
        unit_amount: +(r.amount / r.hours).toFixed(2),
        amount: +(+r.amount).toFixed(2),
      })),
      total: +rows.reduce((s, r) => s + +r.amount, 0).toFixed(2),
    };
  }

  // Fixed and retainer: approved milestones that no invoice line already claims.
  const { rows } = await c.query(`
    SELECT m.id, m.name, m.value_amount
      FROM milestones m
     WHERE m.project_id = $1
       AND m.approved_at IS NOT NULL
       AND m.value_amount > 0
       AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.milestone_id = m.id)
     ORDER BY m.position`, [projectId]);
  return {
    project,
    lines: rows.map(m => ({
      milestone_id: m.id,
      description: `${project.name} — ${m.name}`,
      quantity: 1,
      unit_amount: +m.value_amount,
      amount: +m.value_amount,
    })),
    total: +rows.reduce((s, m) => s + +m.value_amount, 0).toFixed(2),
  };
}

/** Creates a draft invoice for whatever is billable, and locks what it bills. */
export async function draftInvoice(c, tenantId, projectId, { termDays = 30 } = {}) {
  const b = await billable(c, projectId);
  if (!b) return { error: 'No such project, or it is not yours to invoice', status: 404 };
  if (!b.lines.length) {
    return {
      error: b.project.billing_type === 'hourly'
        ? 'There is no unbilled billable time on this project.'
        : 'No approved milestone is waiting to be invoiced. The client signs off first.',
      status: 422,
    };
  }

  const { rows: cl } = await c.query('SELECT client_id FROM projects WHERE id = $1', [projectId]);
  const number = await nextNumber(c, tenantId);

  const { rows: inv } = await c.query(`
    INSERT INTO invoices (tenant_id, client_id, project_id, number, issued_on, due_on,
                          currency, subtotal, total, status)
    VALUES ($1,$2,$3,$4,current_date,current_date + $5::int,$6,$7,$7,'draft')
    RETURNING id, number, total, status, issued_on, due_on`,
    [tenantId, cl[0].client_id, projectId, number, termDays, b.project.currency, b.total]);
  const invoice = inv[0];

  for (const l of b.lines) {
    await c.query(`
      INSERT INTO invoice_lines (tenant_id, invoice_id, milestone_id, description, quantity, unit_amount)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, invoice.id, l.milestone_id || null, l.description, l.quantity, l.unit_amount]);
  }

  // Claim the time this invoice bills. On a milestone invoice, claim every
  // unbilled entry up to today too — that work is what the milestone paid for.
  const { rowCount: locked } = await c.query(`
    UPDATE time_entries SET invoice_id = $1, locked_at = now()
     WHERE project_id = $2 AND invoice_id IS NULL AND billable`, [invoice.id, projectId]);

  return { invoice: { ...invoice, lines: b.lines, locked_entries: locked } };
}

/* Sending and settling live in payments.js.
   `advance()` used to flip status directly and has been removed: an invoice may
   only become paid when payment records add up to its total, and leaving a
   second code path that could set it by hand would defeat that. */
