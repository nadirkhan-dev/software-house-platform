import crypto from 'node:crypto';

/* ============================================================
   Secrets
   ============================================================ */

/**
 * Reads a required secret. There is deliberately no fallback.
 *
 * A default like 'dev-only-secret-change-me' is worse than no secret at all:
 * it works perfectly in every environment, so nobody notices it reached
 * production, and anyone who has read the source can forge a session for any
 * user in any tenant. Refusing to boot is the only safe behaviour.
 */
export function requireSecret(name, { minLength = 32 } = {}) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Generate one with:  openssl rand -hex 32\n` +
      `Refusing to start without it.`);
  }
  if (v.length < minLength) {
    throw new Error(`${name} is too short (${v.length} chars, need ${minLength}).`);
  }
  if (/change-?me|dev-only|placeholder|secret123/i.test(v)) {
    throw new Error(`${name} looks like a placeholder. Use a real random value.`);
  }
  return v;
}

/* ============================================================
   Security headers
   ============================================================ */

/**
 * Written out rather than pulled from helmet: it is nine headers, we want to
 * understand each one, and the CSP has to know about our own asset origins.
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/* ============================================================
   Rate limiting
   ============================================================ */

/**
 * Sliding-window limiter, in process memory.
 *
 * This is correct for a single instance and wrong the moment you run two: each
 * process would keep its own counters and the effective limit would multiply by
 * the instance count. The store is behind an interface so it can be swapped for
 * Redis without touching call sites — do that before horizontal scaling, not
 * after.
 */
class MemoryStore {
  constructor() { this.hits = new Map(); setInterval(() => this.sweep(), 60_000).unref?.(); }
  hit(key, windowMs) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length;
  }
  reset(key) { this.hits.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      if (!arr.length || now - arr[arr.length - 1] > 3_600_000) this.hits.delete(k);
    }
  }
}
export const store = new MemoryStore();

export function rateLimit({ windowMs, max, keyOn = req => req.ip, message }) {
  return (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const key = `${req.method}:${req.path}:${keyOn(req)}`;
    const count = store.hit(key, windowMs);
    const remaining = Math.max(0, max - count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    if (count > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

/** Credential stuffing is per-account as much as per-IP, so key on both. */
export const loginLimiter = [
  rateLimit({ windowMs: 15 * 60_000, max: 20, keyOn: r => r.ip,
    message: 'Too many sign-in attempts from this address. Try again in a few minutes.' }),
  rateLimit({ windowMs: 15 * 60_000, max: 8,
    keyOn: r => String(r.body?.email || '').toLowerCase(),
    message: 'Too many sign-in attempts for this account. Try again in a few minutes.' }),
];

export const apiLimiter = rateLimit({ windowMs: 60_000, max: 300 });
export const writeLimiter = rateLimit({ windowMs: 60_000, max: 60 });

/* ============================================================
   CSRF
   ============================================================ */

const CSRF_COOKIE = 'mgn_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit token.
 *
 * The session lives in a cookie, so a cross-site form post would otherwise
 * arrive fully authenticated. SameSite=Lax blocks the obvious cases but not
 * top-level POST navigations in every browser, and it is not a control we want
 * to be the only one. The token is readable by our own JS and echoed in a
 * header; an attacker on another origin can cause the cookie to be sent but
 * cannot read it to set the header.
 */
export function csrf(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,          // the browser app must be able to read it
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  res.locals.csrfToken = token;

  if (SAFE.has(req.method)) return next();

  const sent = req.get('x-csrf-token');
  if (!sent || !token) return res.status(403).json({ error: 'Missing CSRF token' });
  const a = Buffer.from(sent), b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}
