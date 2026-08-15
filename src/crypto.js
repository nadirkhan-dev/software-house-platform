import crypto from 'node:crypto';
import { requireSecret } from './security.js';

/**
 * Envelope encryption for third-party credentials.
 *
 * OAuth tokens are stored encrypted so that a database dump — a backup on a
 * laptop, a misconfigured replica, a SQL injection that only reads — does not
 * hand over a live Asana session for every tenant at once. The key lives in the
 * environment, never in the database, so the two have to be stolen separately.
 *
 * AES-256-GCM rather than CBC: it authenticates as well as encrypts, so a
 * tampered ciphertext fails loudly instead of decrypting to garbage that some
 * code downstream then treats as a token.
 */

const ALGO = 'aes-256-gcm';
let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  // Falls back to SESSION_SECRET so a single-secret deployment still works,
  // but a separate ENCRYPTION_KEY is better: rotating your session secret
  // should not make every stored token undecryptable.
  const raw = process.env.ENCRYPTION_KEY || requireSecret('SESSION_SECRET');
  cachedKey = crypto.createHash('sha256').update(raw).digest();
  return cachedKey;
}

/** Returns `v1.iv.tag.ciphertext`, all base64url. The version prefix is what
 *  makes key rotation possible later without guessing at old formats. */
export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'),
          enc.toString('base64url')].join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [v, iv, tag, data] = String(payload).split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Malformed ciphertext');
  const d = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** For OAuth `state`: signed, short-lived, and carries the tenant it belongs to. */
export function signState(payload, ttlMs = 10 * 60_000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const mac = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyState(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return Date.now() > p.exp ? null : p;
}
