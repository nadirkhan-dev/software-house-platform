import './env.js';   // DATABASE_URL is read at module scope below, so load .env first
import pg from 'pg';

// Money must not arrive as a float. numeric -> string -> Number, deliberately.
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));   // bigint

/**
 * A DATE column is a calendar day, not an instant, and must not become one.
 *
 * node-pg otherwise builds a JS Date at local midnight, so on Asia/Karachi
 * (+05:00) `2026-06-01` serialises as `2026-05-31`. That is silent: billable
 * hours quietly land in the wrong month for everyone outside UTC.
 *
 * Returning the string exactly as Postgres sent it removes timezone from the
 * question. TZ=UTC also masks it, but a deployment that forgets the variable is
 * silently wrong again — a type parser cannot be forgotten.
 */
pg.types.setTypeParser(1082, v => v);   // date   -> 'YYYY-MM-DD'
pg.types.setTypeParser(1182, v => v);   // date[]

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres@/marginly?host=/tmp&port=5433',
  max: 10,
});

/**
 * The single doorway to the database for anything request-scoped.
 *
 * Every call opens a transaction, declares who is asking, and drops to the
 * unprivileged `app` role before running a line of the caller's SQL. Row-level
 * security then does the work: a query that forgets its WHERE clause returns
 * nothing rather than another agency's payroll.
 *
 * SET LOCAL is scoped to the transaction, so the settings cannot leak onto the
 * next request that borrows this pooled connection.
 */
export async function asUser(ctx, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true)', ['app.tenant_id', ctx.tenantId ?? '']);
    await c.query('SELECT set_config($1,$2,true)', ['app.user_id', ctx.userId ?? '']);
    await c.query('SELECT set_config($1,$2,true)', ['app.role', ctx.role ?? 'developer']);
    if (ctx.ip) await c.query('SELECT set_config($1,$2,true)', ['app.ip', ctx.ip]);
    await c.query('SET LOCAL ROLE app');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Owner-level access. Migrations, seeding and login only — never a request handler. */
export async function asOwner(fn) {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

export async function closePool() { await pool.end(); }
