import nodemailer from 'nodemailer';

/**
 * Email delivery.
 *
 * Three transports, chosen by environment:
 *
 *   SMTP_URL set          → real SMTP via nodemailer
 *   NODE_ENV=test         → an in-memory outbox, so tests can assert on what
 *                           was sent without a mail server
 *   otherwise             → logged to stdout, clearly marked as not sent
 *
 * The third is the honest option for a laptop: it proves the template rendered
 * and the recipient resolved, without pretending a message left the building.
 * Sending never blocks or fails a business write — a mail server being down
 * must not stop an invoice being raised.
 */

let transport = null;
export const outbox = [];   // test transport only

function get() {
  if (transport) return transport;
  if (process.env.SMTP_URL) {
    transport = nodemailer.createTransport(process.env.SMTP_URL, {
      // A slow mail server should not hold a request open.
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    });
  } else if (process.env.NODE_ENV === 'test') {
    transport = { sendMail: async m => { outbox.push(m); return { messageId: 'test-' + outbox.length }; } };
  } else {
    transport = {
      sendMail: async m => {
        console.log(`[email:not-sent] to=${m.to} subject="${m.subject}" ` +
                    `(set SMTP_URL to deliver for real)`);
        return { messageId: 'dev-noop' };
      },
    };
  }
  return transport;
}

export const isConfigured = () => Boolean(process.env.SMTP_URL);

const FROM = () => process.env.MAIL_FROM || 'Marginly <no-reply@marginly.local>';
const BASE = () => process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * One template, themed to match the app: crimson rule for cost, ink blue for
 * revenue. Deliberately table-free and inline-styled, because email clients in
 * 2026 still render like it is 2005.
 */
function layout({ heading, body, cta, ctaUrl, footer }) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#EDF0F5;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0F1319">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E1E6ED;border-radius:6px;overflow:hidden">
      <div style="height:3px;background:linear-gradient(90deg,#B0123E 0 34%,#12406F 34% 100%)"></div>
      <div style="padding:26px">
        <h1 style="margin:0 0 14px;font-size:18px;font-weight:600;letter-spacing:-.02em">${esc(heading)}</h1>
        <div style="font-size:14px;line-height:1.55;color:#39424F">${body}</div>
        ${cta ? `<a href="${esc(ctaUrl)}" style="display:inline-block;margin-top:20px;background:#0F1319;
          color:#fff;text-decoration:none;padding:10px 18px;border-radius:5px;font-size:13.5px;
          font-weight:500">${esc(cta)}</a>` : ''}
      </div>
      <div style="padding:14px 26px;border-top:1px solid #E1E6ED;font-size:11.5px;color:#7C8695">
        ${esc(footer || 'You are receiving this because you have an account on Marginly.')}
      </div>
    </div></body></html>`;
}

/** Plain-text fallback. Some clients only render this, and some people prefer it. */
const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const TEMPLATES = {
  milestone_approved: d => ({
    subject: `${d.client} signed off "${d.name}"`,
    heading: 'A milestone is ready to invoice',
    body: `<p><strong>${esc(d.client)}</strong> has approved <strong>${esc(d.name)}</strong>.</p>
           <p>It now appears under Ready to invoice.</p>`,
    cta: 'Open invoices', path: '/',
  }),
  quote_accepted: d => ({
    subject: `${d.client} accepted ${d.number}`,
    heading: 'Quote accepted',
    body: `<p><strong>${esc(d.client)}</strong> accepted quote <strong>${esc(d.number)}</strong>.</p>
           <p>You can turn it into a project with its milestones already in place.</p>`,
    cta: 'Open quotes', path: '/',
  }),
  quote_rejected: d => ({
    subject: `${d.client} declined ${d.number}`,
    heading: 'Quote declined',
    body: `<p><strong>${esc(d.client)}</strong> declined quote <strong>${esc(d.number)}</strong>.</p>`,
    cta: 'Open quotes', path: '/',
  }),
  quote_sent: d => ({
    subject: `Quote ${d.number} for your review`,
    heading: 'You have a new quote',
    body: `<p>Quote <strong>${esc(d.number)}</strong> is ready for your review.</p>
           <p>You can accept or decline it in your portal.</p>`,
    cta: 'Review the quote', path: '/',
  }),
  invoice_sent: d => ({
    subject: `Invoice ${d.number}`,
    heading: 'You have a new invoice',
    body: `<p>Invoice <strong>${esc(d.number)}</strong> is available in your portal,
           where you can also download the PDF.</p>`,
    cta: 'View the invoice', path: '/',
  }),
  payment_received: d => ({
    subject: `${d.amount} received against ${d.number}`,
    heading: 'Payment received',
    body: `<p><strong>${esc(d.amount)}</strong> has been recorded against
           invoice <strong>${esc(d.number)}</strong>.</p>`,
    cta: 'Open invoices', path: '/',
  }),
  task_assigned: d => ({
    subject: `You were assigned "${d.title}"`,
    heading: 'A task was assigned to you',
    body: `<p><strong>${esc(d.title)}</strong> is now yours.</p>`,
    cta: 'Open tasks', path: '/',
  }),
  expense_submitted: d => ({
    subject: `Expense awaiting approval: ${d.description}`,
    heading: 'An expense needs your decision',
    body: `<p><strong>${esc(d.description)}</strong> has been submitted and is
           waiting for approval before it counts as project cost.</p>`,
    cta: 'Review expenses', path: '/',
  }),
  invoice_overdue: d => ({
    subject: `Invoice ${d.number} is overdue`,
    heading: 'An invoice has passed its due date',
    body: `<p>Invoice <strong>${esc(d.number)}</strong> is past due.</p>`,
    cta: 'Open invoices', path: '/',
  }),
  project_created: d => ({
    subject: `Project "${d.name}" created`,
    heading: 'A project was created',
    body: `<p><strong>${esc(d.name)}</strong> is now active.</p>`,
    cta: 'Open projects', path: '/',
  }),
};

/**
 * Sends one notification by email. Returns a result rather than throwing:
 * callers are business writes, and a mail failure must not roll one back.
 */
export async function sendNotification({ to, kind, data, tenantName }) {
  const t = TEMPLATES[kind];
  if (!t || !to?.length) return { skipped: true };
  const spec = t(data || {});
  const html = layout({
    heading: spec.heading, body: spec.body,
    cta: spec.cta, ctaUrl: BASE() + (spec.path || '/'),
    footer: `Sent by ${tenantName || 'Marginly'}.`,
  });

  try {
    // BCC, not To: one recipient must not learn the whole distribution list.
    const info = await get().sendMail({
      from: FROM(), to: FROM(), bcc: to,
      subject: spec.subject, html, text: strip(spec.body) + `\n\n${BASE()}`,
    });
    return { sent: to.length, messageId: info.messageId };
  } catch (err) {
    console.warn(`[email] delivery failed for ${kind}: ${err.message}`);
    return { failed: true, error: err.message };
  }
}

export async function verifyTransport() {
  if (!process.env.SMTP_URL) return { configured: false };
  try {
    await get().verify?.();
    return { configured: true, ok: true };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

export const clearOutbox = () => { outbox.length = 0; };
