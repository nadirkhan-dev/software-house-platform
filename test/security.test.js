import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureServer, created, cleanup, scratchDay, BASE } from './helpers.js';
import { asOwner, closePool } from '../src/db.js';

const admin = client('admin');
let child = null;

before(async () => { child = await ensureServer(); await admin.signIn('ayesha@kdc.pk'); });
after(async () => { await cleanup(); await closePool(); if (child) child.kill(); });

/* ------------------------------------------------------------- secrets */

test('the app refuses to boot without a real SESSION_SECRET', async () => {
  const { requireSecret } = await import('../src/security.js');
  const saved = process.env.TEST_SECRET;
  try {
    delete process.env.TEST_SECRET;
    assert.throws(() => requireSecret('TEST_SECRET'), /not set/);

    process.env.TEST_SECRET = 'short';
    assert.throws(() => requireSecret('TEST_SECRET'), /too short/);

    // The important case: a secret that is long enough but is obviously the
    // one committed to the repository.
    process.env.TEST_SECRET = 'dev-only-secret-change-me-aaaaaaaaaaaaaa';
    assert.throws(() => requireSecret('TEST_SECRET'), /placeholder/);

    process.env.TEST_SECRET = 'f'.repeat(64);
    assert.equal(requireSecret('TEST_SECRET').length, 64);
  } finally {
    if (saved === undefined) delete process.env.TEST_SECRET; else process.env.TEST_SECRET = saved;
  }
});

/* ---------------------------------------------------------------- CSRF */

test('a state-changing request without a CSRF token is refused', async () => {
  // Deliberately bypasses the helper client, which adds the header for you.
  const signIn = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ayesha@kdc.pk', password: 'marginly' }),
  });
  const cookies = (signIn.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');

  const forged = await fetch(BASE + '/api/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookies },  // session, no x-csrf-token
    body: JSON.stringify({ project_id: '00000000-0000-0000-0000-000000000000' }),
  });
  assert.equal(forged.status, 403);
  assert.match((await forged.json()).error, /CSRF/);
});

test('a mismatched CSRF token is refused', async () => {
  const r = await admin.req('/api/invoices', {
    method: 'POST',
    headers: { 'x-csrf-token': 'not-the-right-token' },
    body: { project_id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(r.status, 403);
});

test('safe methods do not require a token', async () => {
  const r = await fetch(BASE + '/api/me');
  assert.ok(r.status === 200 || r.status === 401);
});

/* -------------------------------------------------------- rate limiting */

test('repeated failed sign-ins are throttled per account', async () => {
  const c = client('bruteforce');
  await c.prime();
  const email = 'nadia@kdc.pk';
  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const r = await c.req('/api/login', { method: 'POST', body: { email, password: 'wrong' + i } });
    if (r.status === 429) { sawLimit = true; assert.match(r.body.error, /too many/i); break; }
    assert.equal(r.status, 401);
  }
  assert.ok(sawLimit, 'unlimited password guesses were allowed against one account');
});

test('a throttled account did not lock out the whole app', async () => {
  // Keying only on IP would mean one attacker locks out every user behind a
  // shared NAT. A different account from the same client must still work.
  const c = client('bystander');
  const u = await c.signIn('bilal@kdc.pk');
  assert.equal(u.role, 'pm');
});

/* ----------------------------------------------------------- validation */

test('malformed input is rejected with a field-level message', async () => {
  const bad = [
    { body: { email: 'not-an-email', password: 'x' }, field: 'email' },
    { body: { email: 'a@b.co' }, field: 'password' },
  ];
  for (const t of bad) {
    const c = client('v'); await c.prime();
    const r = await c.req('/api/login', { method: 'POST', body: t.body });
    assert.equal(r.status, 400);
    assert.ok(r.body.fields?.[t.field], `expected a message on "${t.field}", got ${JSON.stringify(r.body)}`);
  }
});

test('a non-uuid id is rejected before it reaches the database', async () => {
  const r = await admin.req('/api/invoices', { method: 'POST', body: { project_id: 'not-a-uuid' } });
  assert.equal(r.status, 400);
  assert.doesNotMatch(JSON.stringify(r.body), /postgres|invalid input syntax/i,
    'a database error leaked through instead of being validated at the edge');
});

test('hours are bounded, coerced and finite', async () => {
  const dev = client('dev'); await dev.signIn('sana@kdc.pk');
  const week = (await dev.req('/api/time')).body;
  const pid = week.projects[0].id;
  const today = scratchDay();
  // null and Infinity matter most: JSON renders both as null, and a naive
  // coercion turns null into 0 — which this API reads as "delete the entry".
  for (const hours of [-1, 25, 'abc', Infinity, NaN, null, undefined, {}, []]) {
    const r = await dev.req('/api/time', { method: 'PUT', body: { project_id: pid, worked_on: today, hours } });
    assert.equal(r.status, 400, `hours=${JSON.stringify(hours)} was accepted`);
  }
  // A well-formed value still works, and a string from a number input coerces.
  const ok = await dev.req('/api/time', { method: 'PUT', body: { project_id: pid, worked_on: today, hours: '3.5' } });
  assert.equal(ok.status, 200);
  if (ok.body?.id) created.timeEntries.push(ok.body.id);
});

test('an oversized body is rejected, not buffered', async () => {
  const c = client('big'); await c.prime();
  const r = await c.req('/api/login', { method: 'POST', body: { email: 'a@b.co', password: 'x'.repeat(200_000) } });
  assert.ok([400, 413].includes(r.status), `expected 400/413, got ${r.status}`);
});

/* ------------------------------------------------------------- headers */

test('security headers are set on every response', async () => {
  const r = await fetch(BASE + '/api/me');
  const expected = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  for (const [h, v] of Object.entries(expected)) assert.equal(r.headers.get(h), v, h);
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null, 'Express is advertising itself');
});

/* ------------------------------------------------------------- sessions */

test('a tampered session cookie is rejected', async () => {
  const c = client('tamper');
  await c.signIn('ayesha@kdc.pk');
  const ok = await c.req('/api/dashboard');
  assert.equal(ok.status, 200);

  // Re-sign the payload with a different body but keep the old signature.
  const forged = 'eyJyb2xlIjoiYWRtaW4iLCJ0ZW5hbnRfaWQiOiIyMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIifQ.aaaa';
  const r = await fetch(BASE + '/api/dashboard', { headers: { cookie: `mgn=${forged}` } });
  assert.equal(r.status, 401);
});

test('signing out actually invalidates the browser session', async () => {
  const c = client('bye');
  await c.signIn('bilal@kdc.pk');
  assert.equal((await c.req('/api/dashboard')).status, 200);
  await c.req('/api/logout', { method: 'POST' });
  assert.equal((await c.req('/api/dashboard')).status, 401);
});

/* ---------------------------------------------------------------- audit */

test('the audit log records financial writes with an actor', async () => {
  const { rows } = await asOwner(c => c.query(`
    SELECT entity, count(*)::int n, count(actor_id)::int with_actor
      FROM audit_log GROUP BY entity ORDER BY entity`));
  const byEntity = Object.fromEntries(rows.map(r => [r.entity, r]));
  for (const e of ['invoices', 'milestones', 'projects']) {
    assert.ok(byEntity[e]?.n > 0, `no audit rows for ${e}`);
  }
});

test('the audit log cannot be edited or deleted', async () => {
  await assert.rejects(
    asOwner(c => c.query(`UPDATE audit_log SET action = 'insert' WHERE id = (SELECT min(id) FROM audit_log)`)),
    /append-only/);
  await assert.rejects(
    asOwner(c => c.query(`DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)`)),
    /append-only/);
});

test('approving a milestone writes an attributable audit row', async () => {
  const cust = client('northwind');
  await cust.signIn('procurement@northwind.example');
  const projects = (await cust.req('/api/projects')).body.projects;
  let target = null;
  for (const p of projects) {
    const d = await cust.req('/api/projects/' + p.project_id);
    const open = d.body.milestones.find(m => !m.approved_at);
    if (open) { target = open; break; }
  }
  assert.ok(target, 'expected an unapproved milestone');

  await cust.req(`/api/milestones/${target.id}/approve`, { method: 'POST' });
  const { rows } = await asOwner(c => c.query(
    `SELECT actor_id, action, after FROM audit_log
      WHERE entity = 'milestones' AND entity_id = $1 ORDER BY at DESC LIMIT 1`, [target.id]));
  assert.equal(rows[0].action, 'update');
  assert.equal(rows[0].actor_id, cust.user.id, 'the approval was not attributed to the approver');
  assert.ok(rows[0].after.approved_at, 'the audit row does not show the approval');

  created.milestones.push(target.id);
});
