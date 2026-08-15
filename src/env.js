import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads `.env` into process.env.
 *
 * Not `dotenv`: this is fifteen lines, and a dependency that runs before
 * anything else in the process is one worth not having. Not `--env-file`: that
 * flag throws when the file is absent on Node 20, breaking container and
 * systemd deployments where no .env file correctly exists.
 *
 * Real environment variables always win — a value set by your orchestrator
 * must not be silently overridden by a stale file on disk.
 */
export function loadEnv(file = '.env') {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return { loaded: false };

  let count = 0;
  for (const raw of fs.readFileSync(full, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in process.env) continue;          // real environment wins

    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && value[0] === '"' && value.at(-1) === '"') {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else if (value.length > 1 && value[0] === "'" && value.at(-1) === "'") {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    count++;
  }
  return { loaded: true, count };
}

loadEnv();
