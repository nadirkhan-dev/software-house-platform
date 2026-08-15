import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureServer, cleanup, scratchDay } from './helpers.js';
import { closePool } from '../src/db.js';

/**
 * Tenant isolation, proven through the HTTP API rather than against the
 * database directly.
 *
 * Testing RLS with psql proves the policies work. It does not prove the
 * application sets `app.tenant_id` on every code path, connects as the
 * unprivileged role, or fails closed when something is missed. Those are the
 * failures that actually leak data, and only an API-level test catches them.
 *
 * KDC Digital and Lahore Labs are two unrelated agencies in one database.
 * Nothing either does should ever be visible to the other.
 */

const kdc = client('kdc-admin');
const lahore = client('lahore-admin');
const kdcClient = client('northwind');
const lahoreClient = client('acme');
const platform = client('platform');
let child = null;

before(async () => {
  child = await ensureServer();
  await kdc.signIn('ayesha@kdc.pk');
  await lahore.signIn('rehan@lahorelabs.pk');
  await kdcClient.signIn('procurement@northwind.example');
  await lahoreClient.signIn('ap@acme.example');
  await platform.signIn('ops@marginly.app');
});

after(async () => { await cleanup(); await closePool(); if (child) child.kill(); });

/* ---------------------------------------------------------------- listing */

test('each tenant sees only its own projects', async () => {
  const a = (await kdc.req('/api/projects')).body.projects;
  const b = (await lahore.req('/api/projects')).body.projects;

  assert.ok(a.length > 0 && b.length > 0, 'both tenants should have projects');
  const aNames = new Set(a.map(p => p.name));
  const bNames = new Set(b.map(p => p.name));
  for (const n of bNames) assert.ok(!aNames.has(n), `KDC can see Lahore Labs project "${n}"`);
  assert.ok(aNames.has('Checkout replatform'));
  assert.ok(bNames.has('Inventory sync'));
});

test('each tenant sees only its own clients, team and invoices', async () => {
  const aInv = (await kdc.req('/api/invoices')).body.invoices;
  const bInv = (await lahore.req('/api/invoices')).body.invoices;
  assert.ok(aInv.every(i => !i.number.startsWith('LL-')), 'KDC sees a Lahore Labs invoice');
  assert.ok(bInv.every(i => i.number.startsWith('LL-')), 'Lahore Labs sees a KDC invoice');

  const aTeam = (await kdc.req('/api/team')).body.team.map(t => t.full_name);
  const bTeam = (await lahore.req('/api/team')).body.team.map(t => t.full_name);
  for (const n of bTeam) assert.ok(!aTeam.includes(n), `KDC can see Lahore Labs staff member ${n}`);
  assert.ok(!aTeam.includes('Rehan Aslam'));
  assert.ok(!bTeam.includes('Ayesha Siddiqui'));
});

test('dashboard figures never aggregate across tenants', async () => {
  const a = (await kdc.req('/api/dashboard')).body;
  const b = (await lahore.req('/api/dashboard')).body;
  // If tenant scoping were missing anywhere in the rollup, both tenants would
  // report the same combined totals.
  assert.notEqual(a.portfolio.contracted, b.portfolio.contracted);
  assert.notEqual(a.portfolio.hours, b.portfolio.hours);
  assert.ok(a.alerts.every(x => !/Inventory sync|KYC onboarding/.test(x.t)));
  assert.ok(b.alerts.every(x => !/Checkout replatform|Clinician portal/.test(x.t)));
});

/* ------------------------------------------- direct access by known id */

test('a known id from another tenant is a 404, not a 403', async () => {
  // 404 matters: a 403 would confirm the record exists, which is itself a leak.
  const theirs = (await lahore.req('/api/projects')).body.projects[0];
  const r = await kdc.req('/api/projects/' + theirs.project_id);
  assert.equal(r.status, 404, 'KDC reached a Lahore Labs project by id');
});

test('cross-tenant milestone approval is impossible', async () => {
  const theirs = (await lahore.req('/api/projects')).body.projects[0];
  const detail = await lahore.req('/api/projects/' + theirs.project_id);
  const open = detail.body.milestones.find(m => !m.approved_at);
  assert.ok(open, 'expected an unapproved milestone in the other tenant');

  for (const who of [kdc, kdcClient]) {
    const r = await who.req(`/api/milestones/${open.id}/approve`, { method: 'POST' });
    assert.ok(r.status === 404 || r.status === 403,
      `${who.label} got ${r.status} approving another tenant's milestone`);
  }
  const after = await lahore.req('/api/projects/' + theirs.project_id);
  assert.equal(after.body.milestones.find(m => m.id === open.id).approved_at, null,
    'the milestone was approved by an outsider');
});

test('cross-tenant invoicing is impossible', async () => {
  const theirs = (await lahore.req('/api/projects')).body.projects[0];
  const r = await kdc.req('/api/invoices', { method: 'POST', body: { project_id: theirs.project_id } });
  assert.equal(r.status, 404, 'KDC raised an invoice against a Lahore Labs project');
  assert.doesNotMatch(JSON.stringify(r.body), /policy|postgres|relation|SQL/i,
    'the refusal leaked database internals');

  const theirInv = (await lahore.req('/api/invoices')).body.invoices.find(i => i.status !== 'paid');
  const settle = await kdc.req(`/api/invoices/${theirInv.id}/pay`, { method: 'POST' });
  assert.equal(settle.status, 404, 'KDC settled a Lahore Labs invoice');

  const check = (await lahore.req('/api/invoices')).body.invoices.find(i => i.id === theirInv.id);
  assert.equal(check.status, theirInv.status, 'the other tenant\'s invoice changed state');
});

test('cross-tenant time logging is impossible', async () => {
  const theirs = (await lahore.req('/api/projects')).body.projects[0];
  const r = await kdc.req('/api/time', {
    method: 'PUT',
    body: { project_id: theirs.project_id, worked_on: scratchDay(), hours: 4 },
  });
  assert.equal(r.status, 404, 'KDC logged time against a Lahore Labs project');
});

/* -------------------------------------------------- client-to-client */

test('a client of one tenant cannot see a client of another', async () => {
  const a = (await kdcClient.req('/api/projects')).body.projects;
  const b = (await lahoreClient.req('/api/projects')).body.projects;
  assert.ok(a.length > 0 && b.length > 0);
  assert.ok(a.every(p => p.client_name === 'Northwind Retail'));
  assert.ok(b.every(p => p.client_name === 'Acme Industrial'));

  const r = await lahoreClient.req('/api/projects/' + a[0].project_id);
  assert.equal(r.status, 404);
});

/* ------------------------------------------------- platform separation */

test('a platform admin has no route into any tenant\'s data', async () => {
  for (const path of ['/api/dashboard', '/api/projects', '/api/invoices', '/api/team', '/api/time']) {
    const r = await platform.req(path);
    assert.equal(r.status, 403, `platform admin reached ${path}`);
    assert.doesNotMatch(JSON.stringify(r.body || {}), /Checkout|Northwind|Ayesha/,
      `${path} leaked tenant data to platform staff`);
  }
});

test('a platform admin sees tenant metadata only — no business data', async () => {
  const r = await platform.req('/api/platform/tenants');
  assert.equal(r.status, 200);
  assert.equal(r.body.tenants.length, 2);
  const json = JSON.stringify(r.body);
  for (const leak of ['Checkout', 'Northwind', 'Ayesha', 'cost', 'margin', 'rate']) {
    assert.doesNotMatch(json, new RegExp(leak, 'i'), `platform tenant list leaked "${leak}"`);
  }
});

test('a company admin cannot reach the platform console', async () => {
  for (const who of [kdc, lahore, kdcClient]) {
    const r = await who.req('/api/platform/tenants');
    assert.equal(r.status, 403, `${who.label} reached the platform console`);
  }
});
