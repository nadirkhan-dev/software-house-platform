import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Document storage.
 *
 * The driver interface is deliberately tiny — put, get, remove — so swapping
 * local disk for S3 or R2 is one file, not a refactor. Local disk is the
 * default because it works on a laptop with no account anywhere; set
 * STORAGE_DIR to a mounted volume in production, or implement the S3 driver
 * against the same three methods.
 *
 * Files are stored under a generated uuid path, never the user's filename.
 * A filename is attacker-controlled input: `../../etc/passwd` and
 * `..\\..\\config` are both things people send, and joining one onto a base
 * directory is the classic path traversal. The original name is metadata in the
 * database, used only for the download header.
 */

const ROOT = path.resolve(process.env.STORAGE_DIR || './storage');

// A conservative allow-list. Reject by default: an upload endpoint that accepts
// anything is a file server for whoever finds it.
const ALLOWED = new Map([
  ['application/pdf', 'pdf'],
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['text/plain', 'txt'], ['text/csv', 'csv'], ['text/markdown', 'md'],
  ['application/zip', 'zip'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
]);

export const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);

export const isAllowed = type => ALLOWED.has(String(type).split(';')[0].trim());

/** Strips directory components and control characters from a display name. */
export function safeName(name) {
  // Split on BOTH separators before taking the last segment. path.basename() is
  // platform-aware, so on Linux it leaves `..\..\windows\system32` untouched —
  // a Windows client can therefore send a name that looks harmless to POSIX and
  // is a traversal anywhere it is later handled as a Windows path.
  const last = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const base = last.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '');
  return base.slice(0, 200) || 'file';
}

const localDriver = {
  async put(key, buffer) {
    const full = path.join(ROOT, key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
    return { key, bytes: buffer.length };
  },
  async stream(key) {
    const full = path.join(ROOT, key);
    // Belt and braces: even though keys are generated, never serve a resolved
    // path that escaped the storage root.
    if (!full.startsWith(ROOT + path.sep)) throw new Error('Refusing to read outside the storage root');
    await fsp.access(full);
    return fs.createReadStream(full);
  },
  async remove(key) {
    await fsp.rm(path.join(ROOT, key), { force: true });
  },
};

export const driver = localDriver;

/** tenant/yyyy/mm/uuid.ext — sharded so no directory grows without bound. */
export function makeKey(tenantId, filename) {
  const ext = path.extname(safeName(filename)).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '') || '';
  const d = new Date();
  return `${tenantId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/` +
         `${crypto.randomUUID()}${ext}`;
}

export const checksum = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Collects a request body into memory with a hard ceiling.
 *
 * Streaming straight to disk would avoid buffering, but then a rejected upload
 * has already written bytes and has to be cleaned up. At a 25MB limit,
 * buffering is simpler and the failure mode is "nothing happened".
 */
export function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The one column of the six that a document hangs off. */
export const SCOPES = ['client_id', 'project_id', 'task_id', 'milestone_id', 'invoice_id', 'quote_id'];
