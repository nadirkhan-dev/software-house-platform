import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureServer, cleanup } from './helpers.js';
import { asOwner, closePool } from '../src/db.js';
import { encrypt, decrypt, signState, verifyState } from '../src/crypto.js';
import { isAllowed, safeName, makeKey } from '../src/storage.js';

/**
 * Documents, settings, integrations and email — the modules added in the final
 * phase. Everything created here is removed in teardown, so the suite stays
 * repeatable against one database.
 */

const admin = client('admin');
const dev = client('developer');
const cust = client('client');
const rival = client('lahore-admin');
let child = null;
const made = { documents: [], members: [] };

before(async () => {
  child = await ensureServer();
  await admin.signIn('ayesha@kdc.pk');
  await dev.signIn('sana@kdc.pk');
  await cust.signIn('procurement@northwind.example');
  await rival.signIn('rehan@lahorelabs.pk');
});

after(async () => {
  await asOwner(async c => {
    if (made.documents.length) await c.query('DELETE FROM documents WHERE id = ANY($1)', [made.documents]);
    if (made.members.length) {
      await c.query('DELETE FROM rate_cards WHERE user_id = ANY($1)', [made.members]);
      await c.query('DELETE FROM memberships WHERE user_id = ANY($1)', [made.members]);
      await c.query('DELETE FROM users WHERE id = ANY($1)', [made.members]);
    }
  });
  await cleanup();
  await closePool();
  if (child) child.kill();
});

/* ---------------------------------------------------------------- crypto */

test('tokens survive a round trip and fail loudly when tampered with', () => {
  const secret = 'asana-token-1/0000000000000000:abcdef';
  const box = encrypt(secret);
  assert.notEqual(box, secret, 'the token was stored in the clear');
  assert.match(box, /^v1\./, 'ciphertext should carry a version so keys can rotate');
  assert.equal(decrypt(box), secret);

  // GCM authenticates: a flipped byte must throw, not decrypt to garbage that
  // some caller then treats as a valid token.
  const parts = box.split('.');
  const corrupted = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + 'AA'].join('.');
  assert.throws(() => decrypt(corrupted));
  assert.equal(encrypt(null), null);
});

test('OAuth state is signed, carries its tenant, and expires', () => {
  const s = signState({ t: 'tenant-1', u: 'user-1' });
  assert.equal(verifyState(s).t, 'tenant-1');
  assert.equal(verifyState(s + 'x'), null, 'a tampered state was accepted');
  assert.equal(verifyState(signState({ t: 'x' }, -1000)), null, 'an expired state was accepted');
});

/* --------------------------------------------------------------- storage */

test('uploads are restricted by type and stripped of path components', () => {
  assert.ok(isAllowed('application/pdf'));
  assert.ok(isAllowed('image/png; charset=binary'));
  assert.ok(!isAllowed('application/x-msdownload'), 'executables must be refused');
  assert.ok(!isAllowed('text/html'), 'HTML would run against our own origin');

  // Path traversal: the filename is attacker-controlled and must never be
  // joined onto a directory as-is.
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\windows\\system32'), '..\\..\\windows\\system32'.split(/[\\/]/).pop());
  assert.ok(!makeKey('tenant', '../../x.pdf').includes('..'), 'the storage key escaped its prefix');
});

/* ------------------------------------------------------------- documents */

test('a document is uploaded, listed and downloaded with its bytes intact', async () => {
  const project = (await admin.req('/api/projects')).body.projects[0];
  const body = 'Acceptance test document\nline two\n';

  const up = await admin.raw(`/api/documents?project_id=${project.project_id}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-filename': 'test-doc.txt' },
    body,
  });
  assert.equal(up.status, 201);
  const doc = (await up.json()).document;
  made.documents.push(doc.id);
  assert.equal(doc.byte_size, Buffer.byteLength(body));
  assert.equal(doc.client_visible, false, 'documents must be internal by default');

  const down = await admin.raw(`/api/documents/${doc.id}/download`);
  assert.equal(down.status, 200);
  assert.equal(await down.text(), body, 'the downloaded bytes differ from what was uploaded');
  assert.match(down.headers.get('content-disposition') ?? '', /attachment/,
    'files must download, never render inline against our origin');
});

test('an executable is refused', async () => {
  const project = (await admin.req('/api/projects')).body.projects[0];
  const r = await admin.raw(`/api/documents?project_id=${project.project_id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-msdownload', 'x-filename': 'evil.exe' },
    body: 'MZ',
  });
  assert.equal(r.status, 415);
});

test('an upload must name what it attaches to', async () => {
  const r = await admin.raw('/api/documents', {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'orphan.txt' }, body: 'x',
  });
  assert.equal(r.status, 400);
});

test('a client sees only documents shared with them, and cannot upload', async () => {
  const all = (await admin.req('/api/documents')).body.documents;
  const theirs = (await cust.req('/api/documents')).body.documents;
  assert.ok(theirs.length < all.length, 'the client saw every internal document');
  assert.ok(theirs.every(d => d.client_visible), 'an internal document reached a client');

  const project = (await cust.req('/api/projects')).body.projects[0];
  const r = await cust.raw(`/api/documents?project_id=${project.project_id}`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'x.txt' }, body: 'x',
  });
  assert.equal(r.status, 403);
});

test('sharing a document with the client makes it visible, and only then', async () => {
  const doc = (await admin.req('/api/documents')).body.documents.find(d => !d.client_visible);
  assert.ok(doc, 'expected an internal document');
  const before = (await cust.req('/api/documents')).body.documents.length;

  await admin.req(`/api/documents/${doc.id}`, { method: 'PATCH', body: { client_visible: true } });
  assert.equal((await cust.req('/api/documents')).body.documents.length, before + 1);

  await admin.req(`/api/documents/${doc.id}`, { method: 'PATCH', body: { client_visible: false } });
  assert.equal((await cust.req('/api/documents')).body.documents.length, before);
});

test('documents do not cross tenants', async () => {
  const ours = (await admin.req('/api/documents')).body.documents[0];
  const r = await rival.raw(`/api/documents/${ours.id}/download`);
  assert.equal(r.status, 404);
  const theirs = (await rival.req('/api/documents')).body.documents;
  assert.ok(theirs.every(d => !made.documents.includes(d.id)));
});

/* -------------------------------------------------------------- settings */

test('settings are readable by finance and writable only by an admin', async () => {
  const r = await admin.req('/api/settings');
  assert.equal(r.status, 200);
  assert.ok(r.body.company.name);
  assert.ok(r.body.team.length > 0);

  assert.equal((await dev.req('/api/settings')).status, 403);

  const saved = await admin.req('/api/settings', {
    method: 'PATCH', body: { payment_terms_days: 45 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.company.payment_terms_days, 45);
  await admin.req('/api/settings', { method: 'PATCH', body: { payment_terms_days: 30 } });
});

test('unknown settings keys are rejected rather than silently ignored', async () => {
  const r = await admin.req('/api/settings', { method: 'PATCH', body: { plan: 'enterprise' } });
  assert.equal(r.status, 400, 'a caller upgraded their own plan through the settings endpoint');
});

test('inviting a colleague creates a rate card so their first time entry works', async () => {
  const email = `invite-test-${Date.now()}@kdc.pk`;
  const r = await admin.req('/api/settings/team', {
    method: 'POST',
    body: { email, full_name: 'Invite Test', role: 'developer', cost_amount: 200000, bill_rate: 30 },
  });
  assert.equal(r.status, 201);
  made.members.push(r.body.member.id);
  assert.equal(r.body.member.needs_password, true);

  const { rows } = await asOwner(c => c.query(
    'SELECT cost_amount, bill_rate FROM rate_cards WHERE user_id = $1', [r.body.member.id]));
  assert.equal(Number(rows[0].cost_amount), 200000, 'no rate card was created for the new member');

  // Inviting the same person twice is a conflict, not a duplicate membership.
  assert.equal((await admin.req('/api/settings/team', {
    method: 'POST', body: { email, full_name: 'Invite Test', role: 'developer' },
  })).status, 409);
});

test('a developer cannot invite or change roles', async () => {
  assert.equal((await dev.req('/api/settings/team', {
    method: 'POST', body: { email: 'x@y.co', full_name: 'X', role: 'admin' },
  })).status, 403);
});

/* ---------------------------------------------------------- integrations */

test('integrations report their real state, with no secrets in the payload', async () => {
  const r = await admin.req('/api/integrations');
  assert.equal(r.status, 200);
  assert.equal(r.body.asana.configured, false, 'no Asana credentials are set in test');
  assert.match(r.body.asana.reason, /ASANA_CLIENT_ID/);
  assert.equal(r.body.email.configured, false);
  assert.ok(r.body.storage.maxBytes > 0);

  const json = JSON.stringify(r.body);
  assert.doesNotMatch(json, /access_token|refresh_token|client_secret/,
    'the integrations payload leaked credential fields');
});

test('connecting Asana without server credentials fails honestly', async () => {
  const r = await admin.req('/api/integrations/asana/connect');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not configured/);
});

test('only an admin can touch integrations', async () => {
  assert.equal((await dev.req('/api/integrations')).status, 403);
  assert.equal((await cust.req('/api/integrations/asana/connect')).status, 403);
  assert.equal((await cust.req('/api/integrations/asana/disconnect', { method: 'POST' })).status, 403);
});

test('the Asana callback refuses a forged state', async () => {
  const r = await admin.raw('/api/integrations/asana/callback?code=x&state=forged.signature');
  assert.equal(r.status, 400);
  assert.match(await r.text(), /expired|Try connecting again/i);
});

/* ------------------------------------------------------------------ email */

test('notifications are emailed as well as stored, without blocking the write', async () => {
  /* The outbox lives in the *server* process, not this one, so importing it
     here would inspect an empty array. The server exposes it under NODE_ENV=test
     for exactly this reason — asserting on a different process's memory is the
     kind of test that passes while the feature is broken. */
  await admin.req('/api/test/outbox', { method: 'DELETE' });

  const projects = (await admin.req('/api/projects')).body.projects;
  let target = null;
  for (const p of projects) {
    const d = await admin.req('/api/projects/' + p.project_id);
    const open = d.body.milestones?.find(m => !m.approved_at);
    if (open) { target = open; break; }
  }
  if (!target) return;

  assert.equal((await admin.req(`/api/milestones/${target.id}/approve`, { method: 'POST' })).status, 200);
  const { created } = await import('./helpers.js');
  created.milestones.push(target.id);

  // Email is fire-and-forget by design, so give the queue a moment.
  await new Promise(r => setTimeout(r, 600));
  const { messages } = (await admin.req('/api/test/outbox')).body;
  const sent = messages.find(m => /signed off/.test(m.subject));
  assert.ok(sent, `no email was queued for a milestone approval (outbox: ${messages.length})`);
  assert.ok(sent.bcc > 0, 'recipients must be BCC, not To — one must not see the others');
  assert.match(sent.html, /invoice/i);
  assert.ok(sent.text.length > 0, 'a plain-text alternative is expected');
});

/* ------------------------------------------------- report filters (brief §3/§5) */

test('reports narrow by client, and offer only options the caller can see', async () => {
  const all = (await admin.req('/api/reports')).body;
  assert.ok(all.options.clients.length > 0);
  assert.ok(all.options.team.length > 0);

  const northwind = all.options.clients.find(c => c.name === 'Northwind Retail');
  const filtered = (await admin.req(`/api/reports?client=${northwind.id}`)).body;
  assert.ok(filtered.projects.length < all.projects.length, 'the client filter did not narrow anything');
  assert.ok(filtered.projects.every(p => p.client_name === 'Northwind Retail'));
  assert.equal(filtered.clients.length, 1);
});

test('reports narrow by project, team member and date range', async () => {
  const all = (await admin.req('/api/reports')).body;

  const project = all.options.projects[0];
  const byProject = (await admin.req(`/api/reports?project=${project.id}`)).body;
  assert.equal(byProject.projects.length, 1);
  assert.equal(byProject.projects[0].project_id, project.id);

  const person = all.options.team[0];
  const byPerson = (await admin.req(`/api/reports?user=${person.id}`)).body;
  assert.ok(byPerson.projects.length <= all.projects.length);
  assert.equal(byPerson.team.length, 1, 'utilisation should show only the selected person');
  assert.equal(byPerson.team[0].full_name, person.full_name);

  const window = (await admin.req('/api/reports?from=2026-06-01&to=2026-08-31')).body;
  assert.equal(window.revenue.length, 3, 'a three-month window should return three months');
  assert.ok(window.revenue.every(m => m.month >= '2026-06' && m.month <= '2026-09'));
});

test('a malformed filter is discarded rather than reaching SQL', async () => {
  for (const bad of ['client=DROP+TABLE+users', 'project=1;--', 'from=not-a-date', 'user=%27']) {
    const r = await admin.req('/api/reports?' + bad);
    assert.equal(r.status, 200, `${bad} should be ignored, not error`);
    assert.ok(r.body.revenue.length > 0);
  }
});

test('a filter can only narrow what RLS already allows', async () => {
  // A Lahore Labs client id must not open KDC's reports onto their data.
  const theirs = (await rival.req('/api/reports')).body.options.clients[0];
  const r = (await admin.req(`/api/reports?client=${theirs.id}`)).body;
  assert.equal(r.projects.length, 0, 'a cross-tenant filter returned rows');
  assert.equal(r.clients.length, 0);
});

/* ------------------------------------------- document preview (brief §19) */

test('a previewable document renders inline, safely', async () => {
  const doc = (await admin.req('/api/documents')).body.documents
    .find(d => d.content_type === 'text/markdown');
  assert.ok(doc, 'expected a previewable seeded document');
  assert.equal(doc.previewable, true);

  const r = await admin.raw(`/api/documents/${doc.id}/preview`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /inline/);
  // Markdown is served as plain text so it cannot be sniffed as markup.
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.ok((await r.text()).length > 0);
});

test('active content is refused for preview and must be downloaded', async () => {
  const project = (await admin.req('/api/projects')).body.projects[0];
  const up = await admin.raw(`/api/documents?project_id=${project.project_id}`, {
    method: 'POST',
    headers: { 'content-type': 'image/svg+xml', 'x-filename': 'logo.svg' },
    body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  });
  assert.equal(up.status, 201, 'an SVG is a legitimate upload');
  const doc = (await up.json()).document;
  made.documents.push(doc.id);

  // But it must never be rendered inline from our own origin.
  const r = await admin.raw(`/api/documents/${doc.id}/preview`);
  assert.equal(r.status, 415);
  assert.match((await r.json()).error, /cannot be previewed safely/);

  const down = await admin.raw(`/api/documents/${doc.id}/download`);
  assert.equal(down.status, 200);
  assert.match(down.headers.get('content-disposition') ?? '', /attachment/);
});

test('preview respects document permissions', async () => {
  const internal = (await admin.req('/api/documents')).body.documents.find(d => !d.client_visible);
  assert.equal((await cust.raw(`/api/documents/${internal.id}/preview`)).status, 404);
  assert.equal((await rival.raw(`/api/documents/${internal.id}/preview`)).status, 404);
});

/* ------------------------------------------------ task filters (brief §8) */

test('tasks filter by project, assignee and status for the list and calendar views', async () => {
  const all = (await admin.req('/api/tasks')).body.tasks;
  assert.ok(all.length > 0);

  const project = all[0].project_id;
  const byProject = (await admin.req(`/api/tasks?project_id=${project}`)).body.tasks;
  assert.ok(byProject.every(t => t.project_id === project));
  assert.ok(byProject.length < all.length);

  const byStatus = (await admin.req('/api/tasks?status=doing')).body.tasks;
  assert.ok(byStatus.every(t => t.status === 'doing'));

  // The calendar keys on due_on, so it has to be present on the payload.
  assert.ok(all.some(t => t.due_on), 'no task carries a due date for the calendar to place');
  assert.ok(all.every(t => 'due_on' in t && 'priority' in t && 'project_name' in t));
});
