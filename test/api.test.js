import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, ensureServer, created, cleanup, scratchDay, BASE } from './helpers.js';
import { closePool } from '../src/db.js';

const owner  = client('admin');
const finance= client('finance');
const pm     = client('pm');
const dev    = client('developer');
const cust   = client('client');
let child = null;

before(async () => {
  child = await ensureServer();
  await owner.signIn('ayesha@kdc.pk');
  await finance.signIn('nadia@kdc.pk');
  await pm.signIn('bilal@kdc.pk');
  await dev.signIn('sana@kdc.pk');
  await cust.signIn('procurement@northwind.example');
});

/* ------------------------------------------------------------------ auth */

test('a wrong password is rejected', async () => {
  const c = client(); await c.prime();
  const r = await c.req('/api/login', { method: 'POST', body: { email: 'ayesha@kdc.pk', password: 'wrong' } });
  assert.equal(r.status, 401);
  assert.doesNotMatch(JSON.stringify(r.body), /hash|bcrypt|\$2[aby]\$/, 'must not leak credential internals');
});

test('an unknown email is rejected identically', async () => {
  const c = client(); await c.prime();
  const r = await c.req('/api/login', { method: 'POST', body: { email: 'nobody@nowhere.test', password: 'marginly' } });
  assert.equal(r.status, 401);
  // Same message either way, so login cannot be used to enumerate staff.
  assert.equal(r.body.error, 'That email and password do not match');
});

test('protected routes reject an anonymous caller', async () => {
  const c = client(); await c.prime();
  for (const path of ['/api/dashboard', '/api/projects', '/api/team', '/api/time']) {
    assert.equal((await c.req(path)).status, 401, path);
  }
});

test('a forged session cookie is rejected', async () => {
  const r = await fetch(BASE + '/api/dashboard', { headers: { cookie: 'mgn=eyJyb2xlIjoib3duZXIifQ.deadbeef' } });
  assert.equal(r.status, 401);
});

/* ----------------------------------------------------- the margin engine */

test('the owner sees the whole book, and it tells the intended story', async () => {
  const { body } = await owner.req('/api/dashboard');
  assert.equal(body.projects.length, 6);
  assert.ok(body.portfolio.projMargin < body.portfolio.quoted,
    'projected margin should be below what was quoted');
  const checkout = body.projects.find(p => p.name === 'Checkout replatform');
  assert.ok(checkout.burn > 1, 'checkout should be over its cost budget');
  assert.equal(checkout.health, 'bad');
  assert.ok(checkout.effective_rate < 20, 'a fixed bid quoted too low earns a poor hourly rate');
});

test('costs are held at the rate of the day, not revalued at today', async () => {
  const { body } = await owner.req('/api/projects');
  const id = body.projects[0].project_id;
  const d = (await owner.req('/api/projects/' + id)).body;
  assert.ok(d.fxRange.hi - d.fxRange.lo > 1,
    'a months-long project should span a range of daily rates');
  assert.ok(d.fxRange.days > 50, 'each working day should carry its own rate');
});

/* ------------------------------------------------------- permission wall */

test('a developer receives no financial figures at all', async () => {
  const paths = ['/api/dashboard', '/api/projects', '/api/time'];
  for (const path of paths) {
    const { body } = await dev.req(path);
    const json = JSON.stringify(body);
    for (const field of ['cost_base', 'cost_home', 'contract_value', 'revenue_base',
                         'margin', 'budget_cost', 'effective_rate', 'bill_rate']) {
      assert.doesNotMatch(json, new RegExp(`"${field}"`), `${path} leaked ${field} to a developer`);
    }
  }
});

test('alerts obey the same permissions as the dashboard', async () => {
  const { body } = await dev.req('/api/dashboard');
  const text = body.alerts.map(a => a.t + ' ' + a.d).join(' ');
  assert.doesNotMatch(text, /\$[\d,]{3,}|₨/, 'alert copy leaked currency figures to a developer');
  assert.ok(body.alerts.length > 0, 'a developer should still see delivery alerts');
});

test('a developer is refused the team rate card outright', async () => {
  const r = await dev.req('/api/team');
  assert.equal(r.status, 403);
});

test('a PM sees revenue but never salaries', async () => {
  const { body } = await pm.req('/api/projects');
  const p = body.projects[0];
  assert.ok(p.contract_value > 0, 'a PM should see contract value');
  assert.equal(p.cost_base, undefined, 'a PM must not see cost');
  const team = await pm.req('/api/team');
  assert.equal(team.status, 200);
  assert.ok(team.body.team.every(t => t.cost_amount === undefined),
    'a PM must not receive anyone\'s salary');
});

test('row-level security scopes a developer to her own projects', async () => {
  const all = (await owner.req('/api/projects')).body.projects;
  const mine = (await dev.req('/api/projects')).body.projects;
  assert.ok(mine.length > 0 && mine.length < all.length, 'a developer should see a subset');

  // Ask directly for a project she is not on: the database returns no row.
  const hers = new Set(mine.map(p => p.project_id));
  const notHers = all.find(p => !hers.has(p.project_id));
  assert.equal((await dev.req('/api/projects/' + notHers.project_id)).status, 404);
});

test('a client sees only their own projects, and no cost data', async () => {
  const { body } = await cust.req('/api/projects');
  assert.ok(body.projects.length > 0);
  assert.ok(body.projects.every(p => p.client_name === 'Northwind Retail'),
    'a client must not see another client\'s work');
  assert.ok(body.projects.every(p => p.cost_base === undefined && p.margin === undefined),
    'a client must never see what the work costs to produce');

  const all = (await owner.req('/api/projects')).body.projects;
  const other = all.find(p => p.client_name !== 'Northwind Retail');
  assert.equal((await cust.req('/api/projects/' + other.project_id)).status, 404);
});

test('a client sees their own invoices and nobody else\'s', async () => {
  const { body } = await cust.req('/api/invoices');
  assert.ok(body.invoices.length > 0);
  assert.ok(body.invoices.every(i => i.client_name === 'Northwind Retail'));
});

/* ------------------------------------------------------------ timesheets */

test('logging time freezes the rate card and the exchange rate server-side', async () => {
  const t = (await dev.req('/api/time')).body;
  const project = t.projects[0];
  // A day the seed never writes — see scratchDay(). Sharing a day with seeded
  // rows makes this test edit demo data instead of its own.
  const today = scratchDay();
  const existing = t.entries.find(e => e.project_id === project.id && e.worked_on.slice(0, 10) === today);
  assert.equal(existing, undefined, 'the scratch day should start empty');

  const before = Number(t.totals.hours);
  const w = await dev.req('/api/time', { method: 'PUT', body: { project_id: project.id, worked_on: today, hours: 4 } });
  assert.equal(w.status, 200);

  const after = (await dev.req('/api/time')).body;
  // Compare to 2dp. Postgres sums numeric exactly; JS does not, so
  // 95.9 + 4 - 6.7 differs from the server's 93.20 in the last bits and an
  // exact assert here is flaky rather than wrong.
  const expected = before + 4 - Number(existing?.hours || 0);
  assert.equal(Number(after.totals.hours).toFixed(2), expected.toFixed(2));

  // The developer wrote the entry but may not see what it cost.
  assert.equal(after.totals.cost_base, undefined);
  assert.equal(after.totals.value_base, undefined);

  /* Put the day back exactly as it was.
     If the seed already had an entry here we restore its value; if we created
     the row, we register its id so shared teardown deletes it. Restoring by
     arithmetic alone is fragile — it silently no-ops when a previous run left
     a row behind, and then the next run inherits it. */
  created.timeEntries.push(w.body.id);
  await dev.req('/api/time', { method: 'PUT', body: { project_id: project.id, worked_on: today, hours: 0 } });
  const restored = (await dev.req('/api/time')).body;
  assert.equal(Number(restored.totals.hours).toFixed(2), before.toFixed(2), 'the suite must leave no trace');
});

test('setting hours to zero actually removes the entry', async () => {
  // Regression: a BEFORE DELETE trigger returning NEW (which is NULL on DELETE)
  // cancels the delete without error. The API answered 200 and the row stayed.
  const t = (await dev.req('/api/time')).body;
  const pid = t.projects[0].id;
  const day = scratchDay();
  const before = Number(t.totals.hours);

  const w = await dev.req('/api/time', { method: 'PUT', body: { project_id: pid, worked_on: day, hours: 6 } });
  assert.equal(w.status, 200);
  assert.equal(Number((await dev.req('/api/time')).body.totals.hours).toFixed(2), (before + 6).toFixed(2));

  const del = await dev.req('/api/time', { method: 'PUT', body: { project_id: pid, worked_on: day, hours: 0 } });
  assert.equal(del.status, 200);

  const after = (await dev.req('/api/time')).body;
  assert.equal(Number(after.totals.hours).toFixed(2), before.toFixed(2), 'the entry was not actually deleted');
  assert.equal(after.entries.filter(e => e.worked_on.slice(0, 10) === day).length, 0,
    'the row survived a successful-looking delete');
});

test('nonsense hours are rejected', async () => {
  const t = (await dev.req('/api/time')).body;
  const id = t.projects[0].id;
  const today = scratchDay();
  for (const hours of [-1, 25, 'abc']) {
    const r = await dev.req('/api/time', { method: 'PUT', body: { project_id: id, worked_on: today, hours } });
    assert.equal(r.status, 400, `hours=${hours} should be rejected`);
  }
});

test('a developer cannot log time to a project she is not on', async () => {
  const all = (await owner.req('/api/projects')).body.projects;
  const mine = new Set((await dev.req('/api/projects')).body.projects.map(p => p.project_id));
  const notHers = all.find(p => !mine.has(p.project_id));
  const r = await dev.req('/api/time', {
    method: 'PUT',
    body: { project_id: notHers.project_id, worked_on: scratchDay(), hours: 3 },
  });
  assert.notEqual(r.status, 200, 'writing to another team\'s project must not succeed');
});

after(async () => {
  await cleanup();
  await closePool();
  if (child) child.kill();
});

/* ------------------------------------------ notifications, search, reports */

test('a business event notifies the people who must act, not the actor', async () => {
  const projects = (await owner.req('/api/projects')).body.projects;
  let target = null;
  for (const p of projects) {
    const d = await owner.req('/api/projects/' + p.project_id);
    const open = d.body.milestones?.find(m => !m.approved_at);
    if (open) { target = open; break; }
  }
  assert.ok(target, 'expected an unapproved milestone');

  const before = (await finance.req('/api/notifications')).body.unread;
  assert.equal((await owner.req(`/api/milestones/${target.id}/approve`, { method: 'POST' })).status, 200);
  created.milestones.push(target.id);

  const after = await finance.req('/api/notifications');
  assert.equal(after.body.unread, before + 1, 'finance should hear about work becoming invoiceable');
  assert.match(after.body.notifications[0].title, /signed off/);

  // The approver is not told about their own click.
  const own = await owner.req('/api/notifications');
  assert.ok(!own.body.notifications.some(n => n.id === after.body.notifications[0].id));
});

test('notifications are private to their recipient', async () => {
  const devs = await dev.req('/api/notifications');
  assert.equal(devs.status, 200);
  assert.ok(devs.body.notifications.every(n => !/signed off/.test(n.title)),
    'a developer received finance\'s notifications');
});

test('search is scoped by the same rules as everything else', async () => {
  const a = await owner.req('/api/search?q=north');
  assert.ok(a.body.results.length > 0);
  assert.ok(a.body.results.some(r => r.type === 'client'));

  // A developer gets no invoices, quotes, leads or people back.
  const d = await dev.req('/api/search?q=north');
  assert.ok(d.body.results.every(r => !['invoice', 'quote', 'lead', 'person'].includes(r.type)),
    'a developer saw commercial records in search');

  // A client sees only their own.
  const c = await cust.req('/api/search?q=a');
  assert.ok(c.body.results.every(r => r.type !== 'lead' && r.type !== 'person'));
});

test('a one-character search returns nothing rather than everything', async () => {
  const r = await owner.req('/api/search?q=a');
  assert.deepEqual(r.body.results, []);
});

test('reports derive profit from labour and expenses, and hide cost from a PM', async () => {
  const a = await owner.req('/api/reports');
  assert.equal(a.status, 200);
  assert.equal(a.body.revenue.length, 12);
  assert.ok(a.body.projects.length > 0);
  assert.ok(a.body.aging.length > 0);

  // Gross profit must equal revenue minus cost, not an independently stored number.
  const p = a.body.projects.find(x => x.cost_base > 0);
  assert.ok(Math.abs(Number(p.gross_profit) - (Number(p.revenue_base) - Number(p.cost_base))) < 0.01);

  const m = await pm.req('/api/reports');
  assert.equal(m.status, 200);
  assert.ok(m.body.projects.every(x => x.cost_base === undefined), 'a PM was shown project cost');
  assert.equal(m.body.team.length, 0, 'a PM was shown salary-derived utilisation');

  assert.equal((await dev.req('/api/reports')).status, 403);
});
