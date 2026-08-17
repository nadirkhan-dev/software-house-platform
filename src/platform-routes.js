import { Router } from 'express';
import { asUser, asOwner } from './db.js';
import { permissions } from './auth.js';
import { writeLimiter } from './security.js';
import { validate, schemas } from './validate.js';
import * as store from './storage.js';
import * as asana from './asana.js';
import * as mail from './email.js';

export const platformRoutes = Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const perms = req => permissions(req.ctx.role);

const needAdmin = (req, res, next) =>
  req.ctx.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do that' });

/* ========================================================= DOCUMENTS ==== */

/**
 * Upload.
 *
 * The body is the raw file; metadata rides in headers and the query string.
 * That avoids a multipart parser dependency for a single-file endpoint, and it
 * streams from the browser without a FormData round trip.
 */
platformRoutes.post('/documents', writeLimiter, wrap(async (req, res) => {
  if (perms(req).isClient) return res.status(403).json({ error: 'Clients cannot upload here' });

  const scope = store.SCOPES.find(s => req.query[s]);
  if (!scope) {
    return res.status(400).json({
      error: `Attach the document to something: one of ${store.SCOPES.join(', ')}`,
    });
  }
  const scopeId = String(req.query[scope]);
  if (!/^[0-9a-f-]{36}$/i.test(scopeId)) return res.status(400).json({ error: 'That id is not valid' });

  const filename = store.safeName(req.get('x-filename') || 'upload');
  const type = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  if (!store.isAllowed(type)) {
    return res.status(415).json({ error: `${type} files are not accepted` });
  }

  let buf;
  try { buf = await store.readBody(req); }
  catch (e) {
    if (e.code === 'TOO_LARGE') {
      return res.status(413).json({ error: `Files must be under ${Math.round(store.MAX_BYTES / 1048576)}MB` });
    }
    throw e;
  }
  if (!buf.length) return res.status(400).json({ error: 'That file was empty' });

  const key = store.makeKey(req.ctx.tenantId, filename);
  const sum = store.checksum(buf);

  // The row is written first: RLS decides whether this scope is even visible to
  // the caller, and a rejected write must not leave an orphan file on disk.
  let row;
  try {
    row = await asUser(req.ctx, async c => (await c.query(`
      INSERT INTO documents (tenant_id, ${scope}, filename, content_type, byte_size,
                             storage_path, checksum, client_visible, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, filename, content_type, byte_size, client_visible, created_at`,
      [req.ctx.tenantId, scopeId, filename, type, buf.length, key, sum,
       req.query.client_visible === 'true', req.ctx.userId])).rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Nothing to attach that to' });
    throw err;
  }

  await store.driver.put(key, buf);
  res.status(201).json({ document: row });
}));

platformRoutes.get('/documents', wrap(async (req, res) => {
  const scope = store.SCOPES.find(s => req.query[s]);
  const out = await asUser(req.ctx, async c => {
    const where = scope ? `WHERE d.${scope} = $1` : '';
    const args = scope ? [String(req.query[scope]), [...PREVIEWABLE]] : [[...PREVIEWABLE]];
    return (await c.query(`
      SELECT d.id, d.filename, d.content_type, d.byte_size, d.client_visible, d.created_at,
             d.content_type = ANY($${scope ? 2 : 1}::text[]) AS previewable,
             d.project_id, d.client_id, d.invoice_id, d.quote_id, d.task_id, d.milestone_id,
             u.full_name AS uploaded_by
        FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
        ${where} ORDER BY d.created_at DESC LIMIT 200`, args)).rows;
  });
  res.json({ documents: out });
}));

/**
 * Types that are safe to render in the browser.
 *
 * PDFs and raster images only. Notably absent: SVG and HTML, which are active
 * content — served inline from our own origin they would run script against a
 * logged-in session, which is stored XSS with extra steps. Those still download.
 */
const PREVIEWABLE = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/csv', 'text/markdown',
]);

platformRoutes.get('/documents/:id/preview', wrap(async (req, res) => {
  const doc = await asUser(req.ctx, async c => (await c.query(
    `SELECT filename, content_type, storage_path FROM documents WHERE id = $1`,
    [req.params.id])).rows[0]);
  if (!doc) return res.status(404).json({ error: 'No such document' });

  const type = (doc.content_type || '').split(';')[0].trim();
  if (!PREVIEWABLE.has(type)) {
    return res.status(415).json({
      error: 'That file type cannot be previewed safely. Download it instead.',
    });
  }

  let stream;
  try { stream = await store.driver.stream(doc.storage_path); }
  catch { return res.status(410).json({ error: 'That file is no longer in storage' }); }

  // text/* is forced to plain so a .md or .csv cannot be sniffed as markup.
  res.setHeader('Content-Type', type.startsWith('text/') ? 'text/plain; charset=utf-8' : type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Belt and braces: even if something previewable is later mis-typed, this CSP
  // stops it executing anything.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  stream.pipe(res);
}));

platformRoutes.get('/documents/:id/download', wrap(async (req, res) => {
  const doc = await asUser(req.ctx, async c => (await c.query(
    `SELECT filename, content_type, storage_path FROM documents WHERE id = $1`,
    [req.params.id])).rows[0]);
  // RLS already hid it if the caller may not see it, so a miss is a 404.
  if (!doc) return res.status(404).json({ error: 'No such document' });

  let stream;
  try { stream = await store.driver.stream(doc.storage_path); }
  catch { return res.status(410).json({ error: 'That file is no longer in storage' }); }

  res.setHeader('Content-Type', doc.content_type || 'application/octet-stream');
  // attachment, not inline: an SVG or HTML file rendered inline from our own
  // origin would run its script against a logged-in session.
  res.setHeader('Content-Disposition',
    `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.pipe(res);
}));

platformRoutes.patch('/documents/:id', writeLimiter, wrap(async (req, res) => {
  if (typeof req.body?.client_visible !== 'boolean') {
    return res.status(400).json({ error: 'Set client_visible true or false' });
  }
  const out = await asUser(req.ctx, async c => (await c.query(
    `UPDATE documents SET client_visible = $2 WHERE id = $1
      RETURNING id, filename, client_visible`, [req.params.id, req.body.client_visible])).rows[0]);
  if (!out) return res.status(404).json({ error: 'No such document' });
  res.json({ document: out });
}));

platformRoutes.delete('/documents/:id', writeLimiter, wrap(async (req, res) => {
  // Soft delete: the bytes stay until a retention job removes them, so an
  // accidental click is recoverable and the audit trail stays intact.
  const out = await asUser(req.ctx, async c => (await c.query(
    `UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`, [req.params.id])).rows[0]);
  if (!out) return res.status(404).json({ error: 'No such document' });
  res.json({ deleted: true });
}));

/* ========================================================== SETTINGS ==== */

platformRoutes.get('/settings', wrap(async (req, res) => {
  if (!perms(req).seesRevenue) return res.status(403).json({ error: 'Not permitted at your access level' });
  const out = await asUser(req.ctx, async c => {
    const { rows } = await c.query(`
      SELECT name, legal_name, slug, address, tax_id, email, phone, website,
             home_currency, base_currency, plan, seats_included,
             invoice_prefix, quote_prefix, next_invoice_no,
             default_tax_rate, default_tax_label, payment_terms_days,
             payment_instructions, invoice_footer
        FROM tenants WHERE id = $1`, [req.ctx.tenantId]);
    const { rows: team } = await c.query(`
      SELECT u.id, u.full_name, u.email, u.last_seen_at, m.role, m.employment,
             m.weekly_hours, m.is_active, cl.name AS client_name
        FROM memberships m JOIN users u ON u.id = m.user_id
        LEFT JOIN clients cl ON cl.id = m.client_id
       ORDER BY m.is_active DESC, u.full_name`);
    return { company: rows[0], team };
  });
  res.json(out);
}));

platformRoutes.patch('/settings', writeLimiter, needAdmin,
  validate(schemas.settings), wrap(async (req, res) => {
    const fields = Object.keys(req.body);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change' });
    const out = await asUser(req.ctx, async c => (await c.query(
      `UPDATE tenants SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}
        WHERE id = $1 RETURNING name, invoice_prefix, default_tax_rate, payment_terms_days`,
      [req.ctx.tenantId, ...fields.map(f => req.body[f])])).rows[0]);
    res.json({ company: out });
  }));

/** Invite a colleague. Creates the user if the address is new to the platform. */
platformRoutes.post('/settings/team', writeLimiter, needAdmin,
  validate(schemas.invite), wrap(async (req, res) => {
    const { email, full_name, weekly_hours, cost_amount, bill_rate } = req.body;
    // Single-admin workspace. Admin is held by the workspace owner alone and is
    // not grantable over HTTP, so an invite has no role to choose: everybody
    // joins as a developer and is widened, if ever, by hand in the database.
    const role = 'developer';
    const out = await asOwner(async c => {
      await c.query('BEGIN');
      try {
        // Users are global (a contractor may work for several agencies), so the
        // insert is idempotent on email and the membership is what scopes them.
        const { rows: u } = await c.query(`
          INSERT INTO users (email, full_name) VALUES ($1,$2)
          ON CONFLICT (email) DO UPDATE SET full_name = COALESCE(users.full_name, EXCLUDED.full_name)
          RETURNING id, email, full_name, password_hash IS NOT NULL AS has_password`,
          [email, full_name]);

        const dup = await c.query(
          'SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2', [req.ctx.tenantId, u[0].id]);
        if (dup.rowCount) { await c.query('ROLLBACK'); return { error: 'They are already on your team', status: 409 }; }

        await c.query(`
          INSERT INTO memberships (tenant_id, user_id, role, weekly_hours)
          VALUES ($1,$2,$3,$4)`, [req.ctx.tenantId, u[0].id, role, weekly_hours ?? 40]);

        // A rate card from day one: without it their first time entry is
        // rejected by the freeze trigger, which is a confusing first experience.
        await c.query(`
          INSERT INTO rate_cards (tenant_id, user_id, cost_amount, cost_currency, cost_period,
                                  overhead_multiplier, bill_rate, bill_currency, valid_from)
          VALUES ($1,$2,$3,(SELECT home_currency FROM tenants WHERE id=$1),'month',1.90,$4,
                  (SELECT base_currency FROM tenants WHERE id=$1), current_date)`,
          [req.ctx.tenantId, u[0].id, cost_amount ?? 0, bill_rate ?? 0]);

        await c.query('COMMIT');
        return { member: { id: u[0].id, email: u[0].email, full_name: u[0].full_name, role,
                           needs_password: !u[0].has_password } };
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json(out);
  }));

platformRoutes.patch('/settings/team/:id', writeLimiter, needAdmin, wrap(async (req, res) => {
  const { role, is_active, weekly_hours } = req.body ?? {};
  if (role === undefined && is_active === undefined && weekly_hours === undefined) {
    return res.status(400).json({ error: 'Nothing to change' });
  }
  // Admin is not grantable over HTTP. Without this an admin could mint a second
  // admin, and "one owner" would hold only until somebody clicked a dropdown.
  if (role !== undefined && role !== 'developer') {
    return res.status(403).json({
      error: 'This workspace has a single admin. Other members can only be developers.',
    });
  }
  // The last admin must not be able to demote or disable themselves: an agency
  // locked out of its own account is a support incident, not a security win.
  if ((role && role !== 'admin') || is_active === false) {
    const admins = await asUser(req.ctx, async c => (await c.query(
      `SELECT count(*)::int n FROM memberships WHERE role='admin' AND is_active`)).rows[0].n);
    const target = await asUser(req.ctx, async c => (await c.query(
      `SELECT role FROM memberships WHERE user_id=$1`, [req.params.id])).rows[0]);
    if (admins <= 1 && target?.role === 'admin') {
      return res.status(409).json({ error: 'Your workspace needs at least one admin' });
    }
  }

  const sets = [], args = [req.params.id];
  for (const [k, v] of Object.entries({ role, is_active, weekly_hours })) {
    if (v !== undefined) { args.push(v); sets.push(`${k} = $${args.length}`); }
  }
  const out = await asUser(req.ctx, async c => (await c.query(
    `UPDATE memberships SET ${sets.join(', ')} WHERE user_id = $1
      RETURNING user_id, role, is_active, weekly_hours`, args)).rows[0]);
  if (!out) return res.status(404).json({ error: 'No such team member' });
  res.json({ member: out });
}));

/* ====================================================== INTEGRATIONS ==== */

platformRoutes.get('/integrations', wrap(async (req, res) => {
  if (!perms(req).seesRevenue) return res.status(403).json({ error: 'Not permitted at your access level' });
  const out = await asUser(req.ctx, async c => ({
    asana: await asana.status(c),
    email: { configured: mail.isConfigured(), ...(await mail.verifyTransport()) },
    storage: { driver: 'local', maxBytes: store.MAX_BYTES },
  }));
  res.json(out);
}));

platformRoutes.get('/integrations/asana/connect', needAdmin, wrap(async (req, res) => {
  if (!asana.isConfigured()) {
    return res.status(503).json({
      error: 'Asana is not configured on this server. Set ASANA_CLIENT_ID and ASANA_CLIENT_SECRET.',
    });
  }
  res.json({ url: asana.authorizeUrl(req.ctx.tenantId, req.ctx.userId) });
}));

/**
 * OAuth callback. Asana redirects the browser here, so there is no session
 * cookie guarantee and no CSRF header — the signed `state` is what proves the
 * request began with us, and which tenant it belongs to.
 */
platformRoutes.get('/integrations/asana/callback', wrap(async (req, res) => {
  const state = asana.readState(String(req.query.state || ''));
  if (!state) return res.status(400).send(page('That authorisation link has expired. Try connecting again.'));
  if (req.query.error) return res.redirect('/?asana=denied');

  try {
    const tok = await asana.exchangeCode(String(req.query.code));
    const ctx = { tenantId: state.t, userId: state.u, role: 'admin' };
    await asUser(ctx, c => asana.saveConnection(c, state.t, state.u, tok));
    res.redirect('/?asana=connected');
  } catch (err) {
    await asOwner(c => c.query(
      `UPDATE integrations SET last_error=$2 WHERE tenant_id=$1 AND provider='asana'`,
      [state.t, err.message])).catch(() => {});
    res.status(502).send(page(`Asana refused the connection: ${err.message}`));
  }
}));

platformRoutes.post('/integrations/asana/disconnect', writeLimiter, needAdmin, wrap(async (req, res) => {
  const out = await asUser(req.ctx, c => asana.disconnect(c));
  res.json(out);
}));

platformRoutes.get('/integrations/asana/projects', needAdmin, wrap(async (req, res) => {
  const out = await asUser(req.ctx, async c => {
    const st = await asana.status(c);
    if (!st.connected) return { error: 'Asana is not connected', status: 409 };
    const ws = req.query.workspace || st.workspace_gid;
    if (!ws) return { error: 'No Asana workspace is selected', status: 409 };
    return { projects: await asana.listProjects(c, String(ws)) };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
}));

platformRoutes.post('/integrations/asana/sync', writeLimiter, needAdmin,
  validate(schemas.asanaSync), wrap(async (req, res) => {
    try {
      const out = await asUser(req.ctx, c => asana.syncProject(c, req.ctx.tenantId, {
        asanaProjectGid: req.body.asana_project_gid,
        projectId: req.body.project_id,
        actorId: req.ctx.userId,
      }));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch (err) {
      await asUser(req.ctx, c => asana.recordError(c, err.message)).catch(() => {});
      res.status(502).json({ error: `Asana sync failed: ${err.message}` });
    }
  }));

/** Minimal HTML for the OAuth callback, which is a browser navigation. */
const page = msg => `<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;padding:40px;max-width:520px;margin:0 auto;color:#0F1319">
<h1 style="font-size:18px">Asana</h1><p style="color:#39424F">${msg
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>
<a href="/" style="color:#12406F">Back to Marginly</a></body>`;
