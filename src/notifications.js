/**
 * Notifications.
 *
 * Two rules keep this from becoming noise:
 *
 *  1. Notify the people who must *act*, not everyone who might be curious. A
 *     feed nobody trusts is a feed nobody reads.
 *  2. Never notify the person who caused the event. Being told about your own
 *     click is the fastest way to teach someone to ignore the bell.
 *
 * Delivery is in-app first. Email is a hook: if SMTP is not configured the
 * notification still lands in the database, and nothing fails. Business writes
 * must not depend on a mail server being up.
 */

const KINDS = {
  quote_sent:          { title: q => `Quote ${q.number} sent`,                 link: '/quotes' },
  quote_accepted:      { title: q => `${q.client} accepted ${q.number}`,       link: '/quotes' },
  quote_rejected:      { title: q => `${q.client} declined ${q.number}`,       link: '/quotes' },
  milestone_approved:  { title: m => `${m.client} signed off "${m.name}"`,     link: '/invoices' },
  invoice_sent:        { title: i => `Invoice ${i.number} sent`,               link: '/invoices' },
  payment_received:    { title: p => `${p.amount} received against ${p.number}`, link: '/invoices' },
  invoice_overdue:     { title: i => `Invoice ${i.number} is overdue`,         link: '/invoices' },
  task_assigned:       { title: t => `You were assigned "${t.title}"`,         link: '/tasks' },
  expense_submitted:   { title: e => `Expense to approve: ${e.description}`,   link: '/expenses' },
  project_created:     { title: p => `Project "${p.name}" created`,            link: '/projects' },
};

/** Everyone in the tenant holding one of these roles, minus the actor. */
async function roleRecipients(c, tenantId, roles, exceptUserId) {
  const { rows } = await c.query(`
    SELECT m.user_id FROM memberships m
     WHERE m.tenant_id = $1 AND m.is_active AND m.role = ANY($2)
       AND ($3::uuid IS NULL OR m.user_id <> $3)`,
    [tenantId, roles, exceptUserId || null]);
  return rows.map(r => r.user_id);
}

/** The client-portal users attached to a given client. */
async function clientRecipients(c, tenantId, clientId, exceptUserId) {
  const { rows } = await c.query(`
    SELECT m.user_id FROM memberships m
     WHERE m.tenant_id = $1 AND m.is_active AND m.role = 'client' AND m.client_id = $2
       AND ($3::uuid IS NULL OR m.user_id <> $3)`,
    [tenantId, clientId, exceptUserId || null]);
  return rows.map(r => r.user_id);
}

/**
 * Writes notifications. Runs on the caller's connection so it shares the
 * transaction: if the business write rolls back, so does the notification.
 * Announcing something that did not happen is worse than announcing nothing.
 */
export async function notify(c, { tenantId, kind, userIds, data, actorId }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown notification kind: ${kind}`);
  const targets = [...new Set(userIds)].filter(u => u && u !== actorId);
  if (!targets.length) return 0;

  const title = spec.title(data);
  for (const uid of targets) {
    await c.query(`
      INSERT INTO notifications (tenant_id, user_id, kind, title, body, link)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, uid, kind, title, data.body || null, spec.link]);
  }
  // Fire-and-forget: a mail failure must never roll back the business write.
  queueEmail({ tenantId, kind, targets, data }).catch(() => {});
  return targets.length;
}

/* ---------------------------------------------------------------- helpers */

export const notifyFinance = (c, ctx, kind, data) =>
  roleRecipients(c, ctx.tenantId, ['admin', 'finance'], ctx.userId)
    .then(ids => notify(c, { tenantId: ctx.tenantId, kind, userIds: ids, data, actorId: ctx.userId }));

export const notifySales = (c, ctx, kind, data) =>
  roleRecipients(c, ctx.tenantId, ['admin', 'sales', 'pm'], ctx.userId)
    .then(ids => notify(c, { tenantId: ctx.tenantId, kind, userIds: ids, data, actorId: ctx.userId }));

export const notifyClient = (c, ctx, clientId, kind, data) =>
  clientRecipients(c, ctx.tenantId, clientId, ctx.userId)
    .then(ids => notify(c, { tenantId: ctx.tenantId, kind, userIds: ids, data, actorId: ctx.userId }));

export const notifyUser = (c, ctx, userId, kind, data) =>
  notify(c, { tenantId: ctx.tenantId, kind, userIds: [userId], data, actorId: ctx.userId });

/* ------------------------------------------------------------------ email */

/**
 * Resolves recipients to addresses and hands off to the mail transport.
 *
 * Runs on its own connection, deliberately not the caller's: it is called
 * fire-and-forget after the business transaction, and reusing that client would
 * mean a mail lookup could interleave with a commit. Anyone with notifications
 * muted still gets the in-app record.
 */
async function queueEmail({ tenantId, kind, targets, data }) {
  const { asOwner } = await import('./db.js');
  const { sendNotification } = await import('./email.js');

  const { rows } = await asOwner(c => c.query(`
    SELECT u.email, t.name AS tenant_name
      FROM users u, tenants t
     WHERE u.id = ANY($1) AND t.id = $2 AND u.email IS NOT NULL`, [targets, tenantId]));
  if (!rows.length) return { skipped: 'no addresses' };

  return sendNotification({
    to: rows.map(r => r.email), kind, data, tenantName: rows[0].tenant_name,
  });
}

/* -------------------------------------------------------------- retrieval */

export async function listNotifications(c, userId, { limit = 30 } = {}) {
  const { rows } = await c.query(`
    SELECT id, kind, title, body, link, read_at, created_at
      FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  const { rows: [{ unread }] } = await c.query(
    `SELECT count(*)::int unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return { notifications: rows, unread };
}

export async function markRead(c, userId, id) {
  // RLS already restricts this to the caller's own rows; the predicate is here
  // so a missing policy cannot silently widen it.
  const { rowCount } = await c.query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2)`,
    [userId, id || null]);
  return rowCount;
}
