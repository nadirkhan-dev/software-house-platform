/**
 * Sales: lead -> client -> quote -> accepted -> project.
 *
 * The chain matters more than any individual screen. An accepted quote becomes
 * a project whose milestones are the quote's own line items, so the thing the
 * client agreed to pay for is literally the thing they later sign off and get
 * invoiced for. That traceability is what stops "what did we actually agree?"
 * six months later.
 */

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* -------------------------------------------------------------------- leads */

export async function convertLead(c, tenantId, leadId) {
  const { rows } = await c.query('SELECT * FROM leads WHERE id = $1', [leadId]);
  const lead = rows[0];
  if (!lead) return { error: 'No such lead', status: 404 };
  if (lead.client_id) return { error: 'That lead has already been converted', status: 409 };
  if (lead.stage === 'lost') return { error: 'A lost lead cannot be converted', status: 409 };

  const { rows: cl } = await c.query(`
    INSERT INTO clients (tenant_id, name, country, currency, notes)
    VALUES ($1,$2,$3,$4,$5) RETURNING id, name`,
    [tenantId, lead.company, null, lead.currency,
     [lead.contact_name && `Contact: ${lead.contact_name}`, lead.email, lead.phone, lead.notes]
       .filter(Boolean).join('\n') || null]);

  // The partial unique index on leads.client_id makes a double conversion fail
  // at the database rather than quietly producing two clients.
  await c.query(`UPDATE leads SET client_id=$2, stage='won', updated_at=now() WHERE id=$1`,
    [leadId, cl[0].id]);

  return { client: cl[0], lead_id: leadId };
}

/* ------------------------------------------------------------------- quotes */

async function nextQuoteNumber(c, tenantId) {
  const { rows } = await c.query(
    `UPDATE tenants SET next_invoice_no = next_invoice_no + 1
      WHERE id = $1 RETURNING next_invoice_no - 1 AS n`, [tenantId]);
  return 'Q-' + String(rows[0].n).padStart(4, '0');
}

/** Totals are computed from the lines, never accepted from the caller. */
function totalsFor(lines, { discount = 0, taxRate = 0 }) {
  const subtotal = round2(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_amount), 0));
  const discounted = round2(Math.max(0, subtotal - Number(discount)));
  const tax = round2(discounted * Number(taxRate));
  return { subtotal, discount: round2(discount), tax, total: round2(discounted + tax) };
}

export async function createQuote(c, tenantId, userId, input) {
  if (!input.lines?.length) return { error: 'A quote needs at least one line', status: 422 };

  const t = totalsFor(input.lines, { discount: input.discount_amount, taxRate: input.tax_rate });
  const number = await nextQuoteNumber(c, tenantId);

  const { rows } = await c.query(`
    INSERT INTO quotes (tenant_id, client_id, lead_id, number, title, description, currency,
                        subtotal, discount_amount, tax_rate, tax_amount, total,
                        payment_terms, expires_on, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15)
    RETURNING id, number, status, total, expires_on`,
    [tenantId, input.client_id, input.lead_id || null, number, input.title, input.description || null,
     input.currency || 'USD', t.subtotal, t.discount, input.tax_rate || 0, t.tax, t.total,
     input.payment_terms || null, input.expires_on || null, userId]);

  let i = 0;
  for (const l of input.lines) {
    await c.query(`
      INSERT INTO quote_lines (tenant_id, quote_id, position, description, quantity, unit_amount, is_milestone)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, rows[0].id, i++, l.description, l.quantity, l.unit_amount, l.is_milestone !== false]);
  }
  return { quote: { ...rows[0], ...t } };
}

export async function getQuote(c, quoteId) {
  const { rows } = await c.query(`
    SELECT q.*, cl.name AS client_name, cl.country
      FROM quotes q JOIN clients cl ON cl.id = q.client_id WHERE q.id = $1`, [quoteId]);
  if (!rows[0]) return null;
  const { rows: lines } = await c.query(
    `SELECT id, position, description, quantity, unit_amount, amount, is_milestone
       FROM quote_lines WHERE quote_id = $1 ORDER BY position`, [quoteId]);
  return { ...rows[0], lines };
}

export async function sendQuote(c, quoteId) {
  const q = await getQuote(c, quoteId);
  if (!q) return { error: 'No such quote', status: 404 };
  if (q.status !== 'draft') return { error: `That quote is already ${q.status}`, status: 409 };
  if (q.expires_on && new Date(q.expires_on) < new Date()) {
    return { error: 'Set an expiry date in the future before sending', status: 422 };
  }
  const { rows } = await c.query(
    `UPDATE quotes SET status='sent', sent_at=now() WHERE id=$1 RETURNING id, number, status`, [quoteId]);
  return { quote: rows[0] };
}

/** Expiry is evaluated on read, so a quote cannot be accepted after its date. */
function isExpired(q) {
  return q.expires_on && new Date(q.expires_on) < new Date(new Date().toDateString());
}

export async function decideQuote(c, quoteId, decision, { userId, ip, reason }) {
  const q = await getQuote(c, quoteId);
  if (!q) return { error: 'No such quote', status: 404 };
  // Only a quote the client has actually been sent may be decided. A draft is
  // still being priced internally; accepting one would let a client commit the
  // agency to numbers nobody signed off, and would skip the sent_at record that
  // proves what was put in front of them.
  if (!['sent', 'viewed'].includes(q.status)) {
    return {
      error: q.status === 'draft'
        ? 'That quote has not been sent yet'
        : `A quote that is ${q.status} cannot be ${decision}`,
      status: 409,
    };
  }
  if (isExpired(q)) {
    await c.query(`UPDATE quotes SET status='expired' WHERE id=$1`, [quoteId]);
    return { error: 'That quote has expired. Ask for a new one.', status: 409 };
  }

  const { rows } = await c.query(`
    UPDATE quotes SET status=$2, decided_at=now(), decided_by=$3, decided_ip=$4, reject_reason=$5
     WHERE id=$1 RETURNING id, number, status, decided_at`,
    [quoteId, decision, userId, ip || null, decision === 'rejected' ? (reason || null) : null]);

  if (decision === 'accepted' && q.lead_id) {
    await c.query(`UPDATE leads SET stage='won', updated_at=now() WHERE id=$1`, [q.lead_id]);
  }
  return { quote: rows[0] };
}

/**
 * Accepted quote -> project.
 *
 * Every line marked as a milestone becomes one, carrying its own value across.
 * The project's contract value is the quote's total, so margin is measured
 * against what was actually sold rather than a number retyped later.
 */
export async function projectFromQuote(c, tenantId, quoteId, input = {}) {
  const q = await getQuote(c, quoteId);
  if (!q) return { error: 'No such quote', status: 404 };
  if (q.status !== 'accepted') {
    return { error: 'Only an accepted quote can become a project', status: 409 };
  }
  if (q.project_id) return { error: 'That quote already has a project', status: 409 };

  const { rows } = await c.query(`
    INSERT INTO projects (tenant_id, client_id, name, billing_type, contract_value, currency,
                          target_margin, starts_on, due_on, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, current_date),$9,'active')
    RETURNING id, name, contract_value, starts_on, due_on`,
    [tenantId, q.client_id, input.name || q.title, input.billing_type || 'fixed',
     q.total, q.currency, input.target_margin ?? 0.40,
     input.starts_on || null, input.due_on || null]);
  const project = rows[0];

  const milestoneLines = q.lines.filter(l => l.is_milestone);
  let i = 0;
  for (const l of milestoneLines) {
    await c.query(`
      INSERT INTO milestones (tenant_id, project_id, name, position, value_amount)
      VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, project.id, l.description, i++, l.amount]);
  }

  for (const uid of input.team || []) {
    await c.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id, project_role)
       VALUES ($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [tenantId, project.id, uid]);
  }

  // The partial unique index on quotes.project_id makes a second click fail at
  // the database rather than creating a duplicate project.
  await c.query(`UPDATE quotes SET project_id=$2 WHERE id=$1`, [quoteId, project.id]);

  return { project, milestones: milestoneLines.length };
}

export async function markQuoteViewed(c, quoteId) {
  const { rows } = await c.query(`
    UPDATE quotes SET viewed_at = COALESCE(viewed_at, now()),
                      status = CASE WHEN status='sent' THEN 'viewed' ELSE status END
     WHERE id=$1 AND status IN ('sent','viewed') RETURNING id, status`, [quoteId]);
  return rows[0] || null;
}
