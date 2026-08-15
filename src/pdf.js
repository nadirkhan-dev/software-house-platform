import PDFDocument from 'pdfkit';

/**
 * Invoice and quote PDFs.
 *
 * PDFKit rather than headless Chrome: a browser in the request path is ~300MB
 * of dependency, a second process to supervise, and a class of timeout failures
 * that only appear under load. This draws directly and streams.
 *
 * The palette matches the application — crimson for money owed, ink blue for
 * settled — so a client receiving the PDF sees the same visual language as the
 * portal they log into.
 */

const INK = '#0F1319';
const MUTED = '#7C8695';
const RULE = '#D6DBE3';
const COST = '#B0123E';
const REV = '#12406F';
const GOOD = '#0E6146';

const money = (n, ccy = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy }).format(Number(n) || 0);

/* `timeZone: 'UTC'` is load-bearing. A DATE arrives as 'YYYY-MM-DD', which
   Date.parse reads as UTC midnight; without it toLocaleDateString renders in
   the server's zone and every date on the invoice slips a day west of UTC —
   1 June printed as 31 May, on a document that goes to the client. */
const day = d => d ? new Date(d).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

const STATUS = {
  paid:           { label: 'PAID',           color: GOOD },
  partially_paid: { label: 'PART PAID',      color: REV },
  overdue:        { label: 'OVERDUE',        color: COST },
  void:           { label: 'VOID',           color: MUTED },
  sent:           { label: 'DUE',            color: INK },
  viewed:         { label: 'DUE',            color: INK },
  draft:          { label: 'DRAFT',          color: MUTED },
  accepted:       { label: 'ACCEPTED',       color: GOOD },
  rejected:       { label: 'DECLINED',       color: COST },
  expired:        { label: 'EXPIRED',        color: MUTED },
};

function header(doc, { tenant, title, number, badge }) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(tenant.name, 50, 50);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
     .text([tenant.address, tenant.tax_id && `Tax ID ${tenant.tax_id}`].filter(Boolean).join('\n') ||
           'Karachi, Pakistan', 50, 72, { width: 240 });

  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK)
     .text(title, 320, 46, { width: 225, align: 'right' });
  doc.font('Courier').fontSize(11).fillColor(MUTED)
     .text(number, 320, 76, { width: 225, align: 'right' });

  if (badge) {
    const w = doc.widthOfString(badge.label) + 16;
    doc.roundedRect(545 - w, 96, w, 18, 3).fillColor(badge.color).fill();
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8)
       .text(badge.label, 545 - w, 101, { width: w, align: 'center' });
  }

  // The ledger rule: cost on the left, revenue on the right.
  doc.rect(50, 128, 170, 2).fillColor(COST).fill();
  doc.rect(220, 128, 325, 2).fillColor(REV).fill();
  return 148;
}

function partyBlock(doc, y, left, right) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(left.label, 50, y);
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(left.lines.join('\n'), 50, y + 13, { width: 230 });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(right.label, 320, y, { width: 225, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(INK)
     .text(right.lines.join('\n'), 320, y + 13, { width: 225, align: 'right' });
  return y + 13 + Math.max(left.lines.length, right.lines.length) * 13 + 22;
}

function lineTable(doc, y, lines, ccy) {
  const COLS = { desc: 50, qty: 330, rate: 395, amt: 470 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', COLS.desc, y);
  doc.text('QTY', COLS.qty, y, { width: 50, align: 'right' });
  doc.text('RATE', COLS.rate, y, { width: 60, align: 'right' });
  doc.text('AMOUNT', COLS.amt, y, { width: 75, align: 'right' });
  y += 13;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(INK).stroke();
  y += 9;

  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  for (const l of lines) {
    if (y > 690) { doc.addPage(); y = 60; }
    const h = doc.heightOfString(l.description, { width: 265 });
    doc.fillColor(INK).text(l.description, COLS.desc, y, { width: 265 });
    doc.font('Courier').fontSize(9)
       .text(Number(l.quantity).toLocaleString('en-US'), COLS.qty, y, { width: 50, align: 'right' })
       .text(money(l.unit_amount, ccy), COLS.rate, y, { width: 60, align: 'right' })
       .text(money(l.amount ?? l.quantity * l.unit_amount, ccy), COLS.amt, y, { width: 75, align: 'right' });
    doc.font('Helvetica').fontSize(9.5);
    y += Math.max(h, 12) + 8;
    doc.moveTo(50, y - 4).lineTo(545, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
  }
  return y + 6;
}

function totals(doc, y, rows, ccy) {
  for (const r of rows) {
    if (y > 720) { doc.addPage(); y = 60; }
    doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(r.bold ? 11 : 9.5)
       .fillColor(r.color || (r.bold ? INK : MUTED))
       .text(r.label, 330, y, { width: 130, align: 'right' });
    doc.font(r.bold ? 'Courier-Bold' : 'Courier').fontSize(r.bold ? 11 : 9.5)
       .text(money(r.value, ccy), 470, y, { width: 75, align: 'right' });
    if (r.rule) {
      doc.moveTo(330, y + 15).lineTo(545, y + 15).lineWidth(1).strokeColor(INK).stroke();
      y += 6;
    }
    y += r.bold ? 20 : 15;
  }
  return y;
}

function footer(doc, text) {
  const y = 742;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(text, 50, y + 8, { width: 495 });
}

/* ------------------------------------------------------------------ invoice */

export function invoicePdf({ tenant, invoice, client, lines, payments = [] }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const ccy = invoice.currency || 'USD';
  const balance = Number(invoice.total) - Number(invoice.amount_paid || 0);

  let y = header(doc, {
    tenant, title: 'Invoice', number: invoice.number,
    badge: STATUS[invoice.status] || STATUS.sent,
  });

  y = partyBlock(doc, y,
    { label: 'BILL TO', lines: [client.name, client.country].filter(Boolean) },
    { label: 'DATES', lines: [`Issued  ${day(invoice.issued_on)}`, `Due  ${day(invoice.due_on)}`] });

  if (invoice.project_name) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('PROJECT', 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(invoice.project_name, 50, y + 13);
    y += 36;
  }

  y = lineTable(doc, y, lines, ccy);

  const rows = [{ label: 'Subtotal', value: invoice.subtotal }];
  if (Number(invoice.discount_amount) > 0) rows.push({ label: 'Discount', value: -invoice.discount_amount });
  if (Number(invoice.tax_amount) > 0) rows.push({ label: invoice.tax_label || 'Tax', value: invoice.tax_amount });
  rows.push({ label: 'Total', value: invoice.total, bold: true, rule: true });

  if (payments.length) {
    for (const p of payments) {
      rows.push({
        label: `${p.is_refund ? 'Refund' : 'Paid'} ${day(p.received_on)}${p.reference ? ` · ${p.reference}` : ''}`,
        value: p.amount, color: p.is_refund ? COST : GOOD,
      });
    }
    rows.push({
      label: balance <= 0.005 ? 'Balance' : 'Balance due',
      value: balance, bold: true, rule: true,
      color: balance <= 0.005 ? GOOD : COST,
    });
  }
  y = totals(doc, y + 4, rows, ccy);

  if (invoice.status !== 'paid' && balance > 0.005) {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('HOW TO PAY', 50, y);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(
      tenant.payment_instructions ||
      'Bank transfer or Wise. Please quote the invoice number as the payment reference so we can match it.',
      50, y + 13, { width: 270 });
  }

  if (invoice.notes) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('NOTES', 50, y + 62);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(invoice.notes, 50, y + 75, { width: 270 });
  }

  footer(doc, `${tenant.name} · ${invoice.number} · ${invoice.terms || 'Payment due within 30 days of issue.'}`);
  doc.end();
  return doc;
}

/* -------------------------------------------------------------------- quote */

export function quotePdf({ tenant, quote, client, lines }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const ccy = quote.currency || 'USD';

  let y = header(doc, {
    tenant, title: 'Quote', number: quote.number,
    badge: STATUS[quote.status] || STATUS.draft,
  });

  y = partyBlock(doc, y,
    { label: 'PREPARED FOR', lines: [client.name, client.country].filter(Boolean) },
    { label: 'VALID UNTIL', lines: [day(quote.expires_on)] });

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(quote.title, 50, y, { width: 495 });
  y += 22;
  if (quote.description) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(quote.description, 50, y, { width: 495 });
    y += doc.heightOfString(quote.description, { width: 495 }) + 16;
  }

  y = lineTable(doc, y, lines, ccy);

  const rows = [{ label: 'Subtotal', value: quote.subtotal }];
  if (Number(quote.discount_amount) > 0) rows.push({ label: 'Discount', value: -quote.discount_amount });
  if (Number(quote.tax_amount) > 0)
    rows.push({ label: `Tax (${(Number(quote.tax_rate) * 100).toFixed(1)}%)`, value: quote.tax_amount });
  rows.push({ label: 'Total', value: quote.total, bold: true, rule: true });
  y = totals(doc, y + 4, rows, ccy);

  if (quote.payment_terms) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('PAYMENT TERMS', 50, y + 10);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(quote.payment_terms, 50, y + 23, { width: 270 });
  }

  footer(doc, quote.expires_on
    ? `This quote is valid until ${day(quote.expires_on)}. Accept it in your client portal to begin work.`
    : 'Accept this quote in your client portal to begin work.');
  doc.end();
  return doc;
}
