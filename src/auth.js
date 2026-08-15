import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { asOwner } from './db.js';
import { requireSecret } from './security.js';

// Throws at import time if unset. Better a loud crash on boot than a silent
// forgeable session in production.
const SECRET = requireSecret('SESSION_SECRET');
const MAX_AGE = 1000 * 60 * 60 * 12;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  // Constant-time compare; a fast-failing string compare leaks the signature.
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (Date.now() > p.exp) return null;
  return p;
}

export async function login(email, password) {
  // Login is the one query that must run before a tenant is known, so it runs
  // as owner. It reads nothing but the credential and the membership.
  return asOwner(async c => {
    // LEFT JOIN, not JOIN: a platform admin has no membership and must still
    // be able to sign in — to the platform console, not to anyone's data.
    const { rows } = await c.query(`
      SELECT u.id AS user_id, u.email, u.full_name, u.password_hash,
             u.is_platform_admin,
             m.tenant_id, m.role, m.client_id, t.name AS tenant_name,
             t.home_currency, t.base_currency
        FROM users u
        LEFT JOIN memberships m ON m.user_id = u.id AND m.is_active
        LEFT JOIN tenants t ON t.id = m.tenant_id
       WHERE u.email = $1
       ORDER BY m.tenant_id NULLS LAST LIMIT 1`, [email]);
    const u = rows[0];
    // Always run a hash comparison, even with no user, so response time does
    // not tell an attacker which addresses exist.
    const ok = await bcrypt.compare(password, u?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    if (!u || !ok) return null;
    // A user with neither a membership nor platform rights has nothing to sign
    // in to — treat it as a failed login rather than issuing an empty session.
    if (!u.tenant_id && !u.is_platform_admin) return null;
    await c.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [u.user_id]);
    delete u.password_hash;
    return u;
  });
}

export function issueCookie(res, user) {
  res.cookie('mgn', sign({ ...user, exp: Date.now() + MAX_AGE }), {
    httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearCookie(res) { res.clearCookie('mgn'); }

/** Attaches req.ctx when a valid session is present. Does not reject. */
export function session(req, _res, next) {
  const p = verify(req.cookies?.mgn);
  if (p) req.ctx = { ...p, tenantId: p.tenant_id, userId: p.user_id, ip: req.ip };
  next();
}

export function requireAuth(req, res, next) {
  if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
  // Platform staff have no tenant context, so every tenant route would return
  // empty results and look broken. Refuse explicitly instead.
  if (!req.ctx.tenantId) {
    return res.status(403).json({
      error: 'Platform accounts cannot access company data. Use the platform console.',
    });
  }
  next();
}

export function requirePlatformAdmin(req, res, next) {
  if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
  if (!req.ctx.is_platform_admin) return res.status(403).json({ error: 'Not permitted' });
  next();
}

/**
 * What this role may see. The API uses these to decide which fields to send;
 * the database uses its own policies to decide which rows exist at all. Two
 * independent layers, because the interesting failures are the ones where a
 * developer forgets one.
 */
/**
 * Mirrors the SQL predicates in schema.sql (is_finance, is_assigned_only, ...).
 * Two layers on purpose: the database decides which rows exist, this decides
 * which fields are serialised. Keep them in step — the tests assert both.
 */
export const FINANCE = ['admin', 'finance'];
export const INTERNAL_WIDE = ['admin', 'finance', 'sales', 'pm', 'lead'];
export const ASSIGNED_ONLY = ['developer', 'designer', 'qa'];

export function permissions(role) {
  return {
    seesCost: FINANCE.includes(role),
    seesRevenue: INTERNAL_WIDE.includes(role),
    canInvoice: FINANCE.includes(role),
    canApproveMilestone: role === 'client' || role === 'admin',
    canManageTeam: role === 'admin',
    isClient: role === 'client',
    isAssignedOnly: ASSIGNED_ONLY.includes(role),
  };
}

/** Removes every field the role may not see, at the edge, before serialising. */
export function redact(obj, perms, fields) {
  const out = { ...obj };
  for (const [key, level] of Object.entries(fields)) {
    if (level === 'cost' && !perms.seesCost) delete out[key];
    if (level === 'revenue' && !perms.seesRevenue) delete out[key];
  }
  return out;
}

export const PROJECT_FIELDS = {
  cost_base: 'cost', cost_home: 'cost', margin: 'cost', marginPct: 'cost',
  burn: 'cost', budget_cost: 'cost', projCost: 'cost', projMargin: 'cost',
  health: 'cost', target_margin: 'cost',
  contract_value: 'revenue', revenue_base: 'revenue', effective_rate: 'revenue',
};
