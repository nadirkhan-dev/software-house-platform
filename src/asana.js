import { encrypt, decrypt, signState, verifyState } from './crypto.js';

/**
 * Asana integration.
 *
 * Authentication is OAuth 2.0 against the tenant's own Asana organisation. It
 * is deliberately *not* a personal access token pasted into a settings box:
 * that carries one employee's permissions, breaks the day they leave, and gives
 * the agency no way to see what the integration is actually allowed to touch.
 *
 * The client secret is read server-side only and never reaches the browser.
 * Tokens are encrypted at rest (src/crypto.js).
 *
 * The whole module is optional. With no credentials configured, `isConfigured()`
 * is false, the API says so plainly, and every other part of the product carries
 * on working — an integration that takes the app down when it is switched off
 * is worse than no integration.
 */

const API = 'https://app.asana.com/api/1.0';
const AUTH = 'https://app.asana.com/-/oauth_authorize';
const TOKEN = 'https://app.asana.com/-/oauth_token';

export const isConfigured = () =>
  Boolean(process.env.ASANA_CLIENT_ID && process.env.ASANA_CLIENT_SECRET);

const redirectUri = () =>
  process.env.ASANA_REDIRECT_URI || 'http://localhost:3000/api/integrations/asana/callback';

/* --------------------------------------------------------------- OAuth */

export function authorizeUrl(tenantId, userId) {
  const state = signState({ t: tenantId, u: userId });
  const q = new URLSearchParams({
    client_id: process.env.ASANA_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    state,
  });
  return `${AUTH}?${q}`;
}

export const readState = verifyState;

async function tokenRequest(body) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      ...body,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `Asana returned ${r.status}`);
  return data;
}

export const exchangeCode = code => tokenRequest({ grant_type: 'authorization_code', code });
const refresh = token => tokenRequest({ grant_type: 'refresh_token', refresh_token: token });

/* ---------------------------------------------------------- persistence */

export async function saveConnection(c, tenantId, userId, tok) {
  const me = await call(tok.access_token, '/users/me');
  const workspace = me.workspaces?.[0];
  const { rows } = await c.query(`
    INSERT INTO integrations (tenant_id, provider, access_token, refresh_token, expires_at,
                              account_name, workspace_gid, workspace_name, connected_by)
    VALUES ($1,'asana',$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tenant_id, provider) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token),
      expires_at = EXCLUDED.expires_at, account_name = EXCLUDED.account_name,
      workspace_gid = EXCLUDED.workspace_gid, workspace_name = EXCLUDED.workspace_name,
      connected_by = EXCLUDED.connected_by, connected_at = now(), last_error = NULL
    RETURNING id, account_name, workspace_name, connected_at`,
    [tenantId, encrypt(tok.access_token), encrypt(tok.refresh_token),
     tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
     me.name || me.email, workspace?.gid || null, workspace?.name || null, userId]);
  return rows[0];
}

/** Connection status, with the secrets stripped — this is safe to serialise. */
export async function status(c) {
  if (!isConfigured()) {
    return { configured: false, connected: false,
      reason: 'ASANA_CLIENT_ID and ASANA_CLIENT_SECRET are not set on the server.' };
  }
  const { rows } = await c.query(`
    SELECT i.account_name, i.workspace_name, i.workspace_gid, i.config, i.connected_at,
           i.last_sync_at, i.last_error, u.full_name AS connected_by
      FROM integrations i LEFT JOIN users u ON u.id = i.connected_by
     WHERE i.provider = 'asana'`);
  if (!rows[0]) return { configured: true, connected: false };

  const { rows: links } = await c.query(
    `SELECT entity, count(*)::int n FROM integration_links
      WHERE provider = 'asana' GROUP BY entity`);
  return { configured: true, connected: true, ...rows[0],
           linked: Object.fromEntries(links.map(l => [l.entity, l.n])) };
}

export async function disconnect(c) {
  // Links are kept: they record that a task came from Asana, which stays true
  // after disconnecting. Only the credentials go.
  const { rowCount } = await c.query(`DELETE FROM integrations WHERE provider = 'asana'`);
  return { disconnected: rowCount > 0 };
}

/**
 * Returns a usable access token, refreshing and re-storing it if it has expired.
 * Every caller goes through here so no code path uses a stale token.
 */
async function tokenFor(c) {
  const { rows } = await c.query(
    `SELECT id, access_token, refresh_token, expires_at FROM integrations WHERE provider='asana'`);
  const row = rows[0];
  if (!row) return null;

  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now() + 60_000;
  if (!expired) return decrypt(row.access_token);

  const rt = decrypt(row.refresh_token);
  if (!rt) return null;
  const tok = await refresh(rt);
  await c.query(
    `UPDATE integrations SET access_token=$2, expires_at=$3 WHERE id=$1`,
    [row.id, encrypt(tok.access_token),
     tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]);
  return tok.access_token;
}

/* ------------------------------------------------------------ API calls */

async function call(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Asana returns 429 with Retry-After under load; surfaced, not swallowed.
    },
    body: body ? JSON.stringify({ data: body }) : undefined,
  });
  if (r.status === 429) {
    const wait = r.headers.get('retry-after') || '30';
    throw new Error(`Asana is rate limiting us. Try again in ${wait} seconds.`);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.errors?.[0]?.message || `Asana returned ${r.status}`);
  }
  return data.data;
}

export async function listWorkspaces(c) {
  const t = await tokenFor(c);
  if (!t) return null;
  return call(t, '/workspaces?opt_fields=name');
}

export async function listProjects(c, workspaceGid) {
  const t = await tokenFor(c);
  if (!t) return null;
  return call(t, `/projects?workspace=${encodeURIComponent(workspaceGid)}&archived=false&opt_fields=name,notes`);
}

/* ---------------------------------------------------------------- sync */

const STATUS_FROM_ASANA = section => {
  const n = (section || '').toLowerCase();
  if (/done|complete|shipped/.test(n)) return 'done';
  if (/review|qa|testing/.test(n)) return 'review';
  if (/progress|doing|active|current/.test(n)) return 'doing';
  if (/block/.test(n)) return 'blocked';
  if (/backlog|icebox|later/.test(n)) return 'backlog';
  return 'todo';
};

/**
 * Imports an Asana project's tasks into one of ours.
 *
 * Idempotent by construction: every task is keyed on its Asana gid in
 * `integration_links`, so running this twice updates rather than duplicating.
 * That property is the difference between an integration people trust and one
 * they run once and then avoid.
 *
 * Assignees are matched by email. An unmatched assignee leaves the task
 * unassigned rather than guessing — silently assigning work to the wrong person
 * is worse than leaving a blank.
 */
export async function syncProject(c, tenantId, { asanaProjectGid, projectId, actorId }) {
  const token = await tokenFor(c);
  if (!token) return { error: 'Asana is not connected', status: 409 };

  const { rows: proj } = await c.query('SELECT id, name FROM projects WHERE id = $1', [projectId]);
  if (!proj[0]) return { error: 'No such project, or it is not yours', status: 404 };

  const tasks = await call(token,
    `/tasks?project=${encodeURIComponent(asanaProjectGid)}&opt_fields=` +
    `name,notes,completed,completed_at,due_on,assignee.email,assignee.name,memberships.section.name,permalink_url`);

  // Email -> our user id, once, rather than per task.
  const { rows: people } = await c.query(`
    SELECT u.id, lower(u.email) AS email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.is_active`, [tenantId]);
  const byEmail = new Map(people.map(p => [p.email, p.id]));

  let created = 0, updated = 0, unmatched = 0;

  for (const t of tasks) {
    const section = t.memberships?.[0]?.section?.name;
    const status = t.completed ? 'done' : STATUS_FROM_ASANA(section);
    const email = t.assignee?.email?.toLowerCase();
    const assignee = email ? byEmail.get(email) || null : null;
    if (email && !assignee) unmatched++;

    const { rows: link } = await c.query(
      `SELECT internal_id FROM integration_links
        WHERE provider='asana' AND entity='task' AND external_id=$1`, [t.gid]);

    if (link[0]) {
      await c.query(`
        UPDATE tasks SET title=$2, description=$3, status=$4, due_on=$5,
                         assignee_id=COALESCE($6, assignee_id),
                         completed_at = CASE WHEN $4='done' THEN COALESCE(completed_at, now()) ELSE NULL END
         WHERE id=$1`,
        [link[0].internal_id, t.name, t.notes || null, status, t.due_on || null, assignee]);
      await c.query(
        `UPDATE integration_links SET synced_at=now(), external_url=$2
          WHERE provider='asana' AND entity='task' AND external_id=$1`, [t.gid, t.permalink_url]);
      updated++;
    } else {
      const { rows: made } = await c.query(`
        INSERT INTO tasks (tenant_id, project_id, title, description, status, priority,
                           assignee_id, reporter_id, due_on, position)
        VALUES ($1,$2,$3,$4,$5,'medium',$6,$7,$8,
                COALESCE((SELECT max(position)+1 FROM tasks WHERE project_id=$2 AND status=$5),0))
        RETURNING id`,
        [tenantId, projectId, t.name, t.notes || null, status, assignee, actorId, t.due_on || null]);
      await c.query(`
        INSERT INTO integration_links (tenant_id, provider, entity, external_id, internal_id, external_url)
        VALUES ($1,'asana','task',$2,$3,$4)`,
        [tenantId, t.gid, made[0].id, t.permalink_url]);
      created++;
    }
  }

  await c.query(`
    INSERT INTO integration_links (tenant_id, provider, entity, external_id, internal_id)
    VALUES ($1,'asana','project',$2,$3)
    ON CONFLICT (tenant_id, provider, entity, external_id)
    DO UPDATE SET internal_id = EXCLUDED.internal_id, synced_at = now()`,
    [tenantId, asanaProjectGid, projectId]);

  await c.query(`UPDATE integrations SET last_sync_at=now(), last_error=NULL WHERE provider='asana'`);

  return { created, updated, unmatched, total: tasks.length, project: proj[0].name };
}

export async function recordError(c, message) {
  await c.query(`UPDATE integrations SET last_error=$1 WHERE provider='asana'`,
    [String(message).slice(0, 500)]);
}
