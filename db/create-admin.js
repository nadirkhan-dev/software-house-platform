import '../src/env.js';   // must be first: src/db.js reads DATABASE_URL at module scope
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { asOwner, closePool } from '../src/db.js';

/**
 * Provisions the workspace owner — the one account that holds `admin`.
 *
 * Admin is deliberately not grantable over HTTP (see platform-routes.js: invites
 * are forced to 'developer' and the role-change route refuses anything else), so
 * this script is the only way the role is handed out. Run it again after
 * `npm run reset`, which drops the account along with everything else.
 *
 *   node db/create-admin.js you@example.com "Your Name" [tenant name]
 *
 * Idempotent: re-running against an existing address resets that account's
 * password and re-asserts the admin membership rather than failing.
 */
const [, , emailArg, nameArg, tenantArg = 'KDC Digital'] = process.argv;

if (!emailArg || !nameArg) {
  console.error('usage: node db/create-admin.js <email> <full name> [tenant name]');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
const fullName = nameArg.trim();

// A password the operator did not choose is a password that was never reused
// from somewhere else. Printed once, never stored in plaintext.
const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const generated = !process.env.ADMIN_PASSWORD;

const result = await asOwner(async c => {
  await c.query('BEGIN');
  try {
    const { rows: t } = await c.query('SELECT id, name FROM tenants WHERE name = $1', [tenantArg]);
    if (!t.length) {
      const { rows: all } = await c.query('SELECT name FROM tenants ORDER BY name');
      throw new Error(
        `No tenant named ${JSON.stringify(tenantArg)}. Available: ${all.map(r => r.name).join(', ') || '(none — run npm run seed)'}`);
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows: u } = await c.query(`
      INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3)
      ON CONFLICT (email) DO UPDATE
        SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash
      RETURNING id, (xmax = 0) AS created`, [email, fullName, hash]);

    const { rows: m } = await c.query(`
      INSERT INTO memberships (tenant_id, user_id, role, weekly_hours)
      VALUES ($1,$2,'admin',40)
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET role = 'admin', is_active = true
      RETURNING role`, [t[0].id, u[0].id]);

    // Without a rate card the freeze trigger rejects this account's first time
    // entry, which reads as a bug rather than as missing setup.
    await c.query(`
      INSERT INTO rate_cards (tenant_id, user_id, cost_amount, cost_currency, cost_period,
                              overhead_multiplier, bill_rate, bill_currency, valid_from)
      SELECT $1, $2, 0, home_currency, 'month', 1.90, 0, base_currency, current_date
        FROM tenants WHERE id = $1
      ON CONFLICT DO NOTHING`, [t[0].id, u[0].id]);

    await c.query('COMMIT');
    return { created: u[0].created, tenant: t[0].name, role: m[0].role };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
});

console.log(`
  ${result.created ? 'Created' : 'Updated'} workspace owner

  email     ${email}
  password  ${generated ? password : '(from ADMIN_PASSWORD)'}
  role      ${result.role}
  tenant    ${result.tenant}
${generated ? '\n  This password is shown once and is not recoverable. Store it now.\n' : ''}`);

await closePool();
