import '../src/env.js';   // must be first: src/db.js reads DATABASE_URL at module scope
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asOwner, closePool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GRANTS = `
-- The application connects as this role. It is deliberately not the table
-- owner: owners bypass row-level security, so an app running as owner would
-- have every policy in this file silently disabled.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN CREATE ROLE app; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
`;

/**
 * Drops everything in the public schema, discovered at runtime rather than
 * from a hand-maintained list. A list that must be updated by hand every time
 * a table is added will eventually not be — this one fell eight tables behind.
 */
const DROP = `
DO $$
DECLARE r record;
BEGIN
  -- Views first: they depend on the tables.
  FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema = 'public'
  LOOP EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', r.table_name); END LOOP;

  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename); END LOOP;

  -- Functions too, or a signature change leaves a stale overload behind.
  --
  -- Skip anything an extension owns. schema.sql installs pgcrypto and citext
  -- into public, and Postgres refuses to drop a member of an extension on its
  -- own: "cannot drop function digest(text,text) because extension pgcrypto
  -- requires it" aborts the whole DO block, and the migration with it.
  -- prokind='f' likewise, so an aggregate is not handed to DROP FUNCTION.
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND p.prokind = 'f'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid = p.oid
                                 AND d.classid = 'pg_proc'::regclass
                                 AND d.deptype = 'e')
  LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig); END LOOP;
END $$;
`;

const run = async () => {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await asOwner(async c => {
    console.log('Dropping existing objects…');
    await c.query(DROP);
    console.log('Applying schema…');
    await c.query(schema);
    console.log('Granting to the app role…');
    await c.query(GRANTS);
  });
  console.log('Migrated.');
  await closePool();
};

run().catch(e => { console.error(e.message); process.exit(1); });
