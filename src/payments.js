/**
 * Payments.
 *
 * The invoice's status is a consequence of the payments recorded against it,
 * computed by a database trigger. Nothing here sets `status` directly, and the
 * API deliberately exposes no "mark as paid" that bypasses a payment record —
 * that is how an invoice ends up green in the system and unpaid at the bank.
 */

export async function listPayments(c, invoiceId) {
  const { rows } = await c.query(`
    SELECT p.id, p.amount, p.currency, p.received_on, p.method, p.reference,
           p.notes, p.is_refund, u.full_name AS recorded_by
      FROM payments p
      LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.invoice_id = $1
     ORDER BY p.received_on, p.created_at`, [invoiceId]);
  return rows;
}

/** Invoice plus its running balance — what the UI needs to offer the right actions. */
export async function invoiceWithBalance(c, invoiceId) {
  const { rows } = await c.query(`
    SELECT i.*, cl.name AS client_name, pr.name AS project_name,
           i.total - i.amount_paid AS balance
      FROM invoices i
      JOIN clients cl ON cl.id = i.client_id
      LEFT JOIN projects pr ON pr.id = i.project_id
     WHERE i.id = $1`, [invoiceId]);
  return rows[0] || null;
}

export async function recordPayment(c, tenantId, userId, invoiceId, input) {
  const inv = await invoiceWithBalance(c, invoiceId);
  if (!inv) return { error: 'No such invoice', status: 404 };
  if (inv.status === 'void') return { error: 'That invoice is void', status: 409 };
  if (inv.status === 'draft') {
    return { error: 'Send the invoice before recording a payment against it', status: 409 };
  }

  const amount = input.is_refund ? -Math.abs(input.amount) : Math.abs(input.amount);

  if (input.is_refund && Math.abs(amount) > Number(inv.amount_paid)) {
    return { error: `You cannot refund more than the ${fmt(inv.amount_paid)} received`, status: 422 };
  }

  const { rows } = await c.query(`
    INSERT INTO payments (tenant_id, invoice_id, amount, currency, received_on,
                          method, reference, notes, is_refund, recorded_by)
    VALUES ($1,$2,$3,$4,COALESCE($5, current_date),$6,$7,$8,$9,$10)
    RETURNING id, amount, received_on, method, reference, is_refund`,
    [tenantId, invoiceId, amount, inv.currency, input.received_on || null,
     input.method, input.reference || null, input.notes || null, !!input.is_refund, userId]);

  // The trigger has updated the invoice by now; re-read rather than predict it.
  const after = await invoiceWithBalance(c, invoiceId);
  return {
    payment: rows[0],
    invoice: { id: after.id, number: after.number, status: after.status,
               total: after.total, amount_paid: after.amount_paid, balance: after.balance },
    // Surfaced rather than blocked: duplicate transfers and FX gains are real,
    // and refusing to record money that genuinely arrived is worse than a flag.
    overpaid: Number(after.balance) < -0.005 ? Math.abs(Number(after.balance)) : 0,
  };
}

export async function voidInvoice(c, invoiceId, reason) {
  const inv = await invoiceWithBalance(c, invoiceId);
  if (!inv) return { error: 'No such invoice', status: 404 };
  if (inv.status === 'void') return { error: 'That invoice is already void', status: 409 };
  if (Number(inv.amount_paid) !== 0) {
    // Voiding an invoice that has taken money would orphan the payment. Refund
    // it first, so the ledger shows the money coming in and going back out.
    return { error: 'Refund the payments received before voiding this invoice', status: 409 };
  }

  await c.query(
    `UPDATE invoices SET status='void', voided_at=now(), void_reason=$2 WHERE id=$1`,
    [invoiceId, reason || null]);

  // Release the work it claimed so it can be billed correctly on a new invoice.
  const { rowCount } = await c.query(
    `UPDATE time_entries SET invoice_id = NULL, locked_at = NULL WHERE invoice_id = $1`, [invoiceId]);
  await c.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);

  return { voided: true, released_entries: rowCount };
}

/** draft -> sent, and viewing. Payment states are never set by hand. */
export async function sendInvoice(c, invoiceId) {
  const inv = await invoiceWithBalance(c, invoiceId);
  if (!inv) return { error: 'No such invoice', status: 404 };
  if (inv.status !== 'draft') {
    return { error: `An invoice that is ${inv.status} has already been sent`, status: 409 };
  }
  const { rows } = await c.query(
    `UPDATE invoices SET status = CASE WHEN due_on < current_date THEN 'overdue' ELSE 'sent' END
      WHERE id=$1 RETURNING id, number, status`, [invoiceId]);
  return { invoice: rows[0] };
}

export async function markViewed(c, invoiceId) {
  const { rows } = await c.query(`
    UPDATE invoices
       SET viewed_at = COALESCE(viewed_at, now()),
           status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
     WHERE id = $1 AND status IN ('sent','viewed')
     RETURNING id, status, viewed_at`, [invoiceId]);
  return rows[0] || null;
}

const fmt = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
