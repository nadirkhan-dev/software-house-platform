import assert from 'node:assert/strict';
import { mondayOf } from '../src/dates.js';

export const BASE = process.env.BASE || 'http://localhost:3000';
export const PASSWORD = 'marginly';

/**
 * A cookie-carrying, CSRF-aware client. One instance per signed-in identity, so
 * a test can hold several people open at once and check what each of them can
 * actually reach.
 */
export function client(label = 'anon') {
  const jar = new Map();
  let csrf = null;

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  return {
    label,
    async req(path, opts = {}) {
      const method = opts.method || 'GET';
      const headers = { 'Content-Type': 'application/json' };
      if (jar.size) headers.cookie = cookieHeader();
      if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = csrf;
      Object.assign(headers, opts.headers || {});

      const r = await fetch(BASE + path, {
        method, headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      for (const raw of (r.headers.getSetCookie?.() ?? [])) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (v === '') jar.delete(k); else jar.set(k, v);
        if (k === 'mgn_csrf') csrf = v;
      }

      let body = null;
      try { body = await r.json(); } catch {}
      return { status: r.status, body, headers: r.headers };
    },

    /** Raw fetch that still carries this identity — for PDFs and other binaries. */
    async raw(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (jar.size) headers.cookie = cookieHeader();
      if (csrf && opts.method && !['GET','HEAD','OPTIONS'].includes(opts.method)) headers['x-csrf-token'] = csrf;
      return fetch(BASE + path, { ...opts, headers });
    },

    /** Primes the CSRF cookie the way a browser would before posting. */
    async prime() { await this.req('/api/me'); return this; },

    async signIn(email, password = PASSWORD) {
      await this.prime();
      const r = await this.req('/api/login', { method: 'POST', body: { email, password } });
      assert.equal(r.status, 200, `sign in failed for ${email}: ${JSON.stringify(r.body)}`);
      this.user = r.body.user;
      return r.body.user;
    },
  };
}

/**
 * A date in the current timesheet week that the seed provably never writes.
 *
 * Tests that log time must not share a day with seeded rows. If they do, the
 * PUT takes the UPDATE path, the returned id belongs to a *seeded* entry, and
 * teardown deletes real demo data — which is invisible on the first run and
 * breaks the second. The seed skips weekends, so Saturday of the current week
 * is always empty, is inside the week the API returns, and still resolves an FX
 * rate and a rate card.
 */
export function scratchDay() {
  /* Saturday of the current week, in the same calendar the server and the
     database use. This once walked back with local getters and then formatted
     with toISOString() — the same mix that broke mondayOf() — so east of UTC it
     returned a Friday, landed on a day the seed does write, and the test edited
     demo data instead of its own scratch row. */
  return new Date(Date.parse(mondayOf(new Date())) + 5 * 86_400_000)
    .toISOString().slice(0, 10);
}

/** Boots a server if one is not already listening, so `npm test` just works. */
export async function ensureServer() {
  const up = async () => { try { await fetch(BASE + '/api/me'); return true; } catch { return false; } };
  if (await up()) return null;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['src/server.js'], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await up()) return child;
  }
  child.kill();
  throw new Error('server did not start — is DATABASE_URL set, migrated and seeded?');
}

/**
 * Anything a test creates gets registered here and undone in teardown. Tests
 * that leave state behind pass once and fail on the second run, which teaches
 * people to re-run rather than to look.
 */
export const created = { invoices: [], milestones: [], timeEntries: [] };

export async function cleanup() {
  const { asOwner } = await import('../src/db.js');
  if (!created.invoices.length && !created.milestones.length && !created.timeEntries.length) return;
  await asOwner(async c => {
    await c.query('ALTER TABLE time_entries DISABLE TRIGGER trg_block_locked');
    try {
      if (created.invoices.length) {
        await c.query(`UPDATE time_entries SET invoice_id = NULL, locked_at = NULL
                        WHERE invoice_id = ANY($1)`, [created.invoices]);
        await c.query('DELETE FROM invoice_lines WHERE invoice_id = ANY($1)', [created.invoices]);
        await c.query('DELETE FROM invoices WHERE id = ANY($1)', [created.invoices]);
      }
      if (created.timeEntries.length)
        await c.query('DELETE FROM time_entries WHERE id = ANY($1)', [created.timeEntries]);
      if (created.milestones.length)
        await c.query(`UPDATE milestones SET approved_at = NULL, approved_by = NULL, approved_ip = NULL
                        WHERE id = ANY($1)`, [created.milestones]);
    } finally {
      await c.query('ALTER TABLE time_entries ENABLE TRIGGER trg_block_locked');
    }
  });
  created.invoices.length = 0;
  created.milestones.length = 0;
  created.timeEntries.length = 0;
}
