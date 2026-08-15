-- ============================================================================
-- Marginly — V1 schema (PostgreSQL 15+)
--
-- Three decisions here are expensive to change later. Get them right now:
--
--   1. Tenant isolation is enforced by Postgres row-level security, not by
--      application code. A bug in a WHERE clause cannot leak another agency's
--      data, because the database refuses to return it.
--
--   2. Rate cards are time-versioned. Giving someone a raise must not
--      retroactively change last quarter's margin. Every rate has a validity
--      window and time entries resolve against the window that was open on the
--      day the work happened.
--
--   3. FX is snapshotted onto the time entry. Cost is incurred in PKR, revenue
--      is earned in USD. If you convert historical cost at today's rate, every
--      past margin in the system silently changes whenever the rupee moves.
--      Store the rate; never recompute it.
--
-- Run: psql -d marginly -f schema.sql
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================================
-- 1. TENANCY
-- ============================================================================

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            citext UNIQUE NOT NULL,
  home_currency   char(3) NOT NULL DEFAULT 'PKR',   -- what you pay salaries in
  base_currency   char(3) NOT NULL DEFAULT 'USD',   -- what you report margin in
  plan            text NOT NULL DEFAULT 'studio'
                    CHECK (plan IN ('solo','studio','agency','enterprise')),
  seats_included  int  NOT NULL DEFAULT 10,
  -- Bumped under a row lock when an invoice is raised. max(number)+1 would let
  -- two people invoicing at once mint the same number.
  next_invoice_no int  NOT NULL DEFAULT 1,
  invoice_prefix  text NOT NULL DEFAULT 'INV-',
  quote_prefix    text NOT NULL DEFAULT 'Q-',
  -- Company identity, used on every PDF that leaves the building.
  legal_name      text,
  address         text,
  tax_id          text,
  email           citext,
  phone           text,
  website         text,
  logo_path       text,
  default_tax_rate   numeric(6,4) NOT NULL DEFAULT 0 CHECK (default_tax_rate BETWEEN 0 AND 1),
  default_tax_label  text,
  payment_terms_days int NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  payment_instructions text,
  invoice_footer  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  full_name     text NOT NULL,
  password_hash text,
  mfa_secret    text,
  -- Platform staff. Grants access to /api/platform only — tenant billing,
  -- provisioning, aggregate health. It does NOT grant a tenant context, so
  -- every RLS policy below still evaluates to zero rows for these users.
  is_platform_admin boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A user can belong to more than one tenant (contractors work for several shops)
CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  -- Company-level roles only. Platform administration is deliberately NOT in
  -- this list: see users.is_platform_admin. Mixing the two is how a support
  -- engineer ends up able to read every customer's payroll.
  role         text NOT NULL CHECK (role IN
                 ('admin','finance','sales','pm','lead','developer','designer','qa','client')),
  employment   text NOT NULL DEFAULT 'full_time'
                 CHECK (employment IN ('full_time','part_time','contractor')),
  weekly_hours numeric(5,2) NOT NULL DEFAULT 40,     -- capacity, drives utilisation
  client_id    uuid,                                  -- set only for role='client'
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX ON memberships (tenant_id, role) WHERE is_active;

-- ============================================================================
-- 2. FX — the rate table every cost figure resolves against
-- ============================================================================

-- Direction is the classic source of silent, six-figure errors here, so the
-- column is named after what it holds: how many units of the home currency buy
-- one unit of the base currency. PKR/USD on 1 Aug 2026 = 284.60.
--   base_amount = home_amount / units_per_base
CREATE TABLE fx_rates (
  home_ccy       char(3) NOT NULL,
  base_ccy       char(3) NOT NULL,
  effective_date date    NOT NULL,
  units_per_base numeric(16,6) NOT NULL CHECK (units_per_base > 0),
  source         text NOT NULL DEFAULT 'ecb',
  PRIMARY KEY (home_ccy, base_ccy, effective_date)
);
COMMENT ON TABLE fx_rates IS
  'Daily close. Backfill on tenant creation; a nightly job appends. Never mutate a past row.';

-- Nearest rate at or before a date — weekends and holidays have no close
CREATE OR REPLACE FUNCTION fx_on(p_home char(3), p_base char(3), p_date date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_home = p_base THEN 1 ELSE (
    SELECT units_per_base FROM fx_rates
     WHERE home_ccy = p_home AND base_ccy = p_base AND effective_date <= p_date
     ORDER BY effective_date DESC LIMIT 1) END
$$;

-- ============================================================================
-- 3. RATE CARDS — time-versioned, the reason margins stay honest
-- ============================================================================

CREATE TABLE rate_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  project_id   uuid,                                  -- NULL = the person's default rate

  -- What they cost you, in your home currency, per month
  cost_amount     numeric(14,2) NOT NULL CHECK (cost_amount >= 0),
  cost_currency   char(3) NOT NULL DEFAULT 'PKR',
  cost_period     text NOT NULL DEFAULT 'month' CHECK (cost_period IN ('month','hour')),

  -- Salary is not cost. Office, tools, admin salaries, bench and every
  -- non-billable hour are cost too. 1.7-2.2 is the honest range.
  overhead_multiplier numeric(4,2) NOT NULL DEFAULT 1.90 CHECK (overhead_multiplier >= 1),

  -- What you charge for them, in the client's currency, per hour
  bill_rate       numeric(12,2) CHECK (bill_rate >= 0),
  bill_currency   char(3) NOT NULL DEFAULT 'USD',

  valid_from   date NOT NULL,
  valid_to     date,                                  -- NULL = still current
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- One open-ended card per person per scope at a time
CREATE UNIQUE INDEX rate_cards_one_current
  ON rate_cards (tenant_id, user_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE valid_to IS NULL;
CREATE INDEX ON rate_cards (tenant_id, user_id, valid_from DESC);

-- Loaded cost per hour in home currency, for the rate card open on a given day
CREATE OR REPLACE FUNCTION loaded_cost_per_hour(
  p_tenant uuid, p_user uuid, p_project uuid, p_date date, p_month_hours numeric DEFAULT 176)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN rc.cost_period = 'hour'
              THEN rc.cost_amount * rc.overhead_multiplier
              ELSE rc.cost_amount * rc.overhead_multiplier / p_month_hours END
    FROM rate_cards rc
   WHERE rc.tenant_id = p_tenant AND rc.user_id = p_user
     AND rc.valid_from <= p_date AND (rc.valid_to IS NULL OR rc.valid_to > p_date)
     AND (rc.project_id = p_project OR rc.project_id IS NULL)
   ORDER BY rc.project_id NULLS LAST      -- a project override beats the default
   LIMIT 1
$$;

-- ============================================================================
-- 4. CLIENTS, PROJECTS, MILESTONES
-- ============================================================================

CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  country     text,
  currency    char(3) NOT NULL DEFAULT 'USD',
  -- how money actually arrives from this client
  pay_method  text CHECK (pay_method IN ('wise','payoneer','bank_wire','stripe','paypal','local_transfer')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX ON clients (tenant_id) WHERE archived_at IS NULL;
ALTER TABLE memberships ADD CONSTRAINT memberships_client_fk
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id),
  code           text,                                -- human reference, e.g. NWR-04
  name           text NOT NULL,
  billing_type   text NOT NULL CHECK (billing_type IN ('fixed','hourly','retainer')),
  contract_value numeric(14,2) NOT NULL DEFAULT 0,
  currency       char(3) NOT NULL DEFAULT 'USD',
  target_margin  numeric(5,4) NOT NULL DEFAULT 0.40 CHECK (target_margin BETWEEN 0 AND 1),
  -- retainers only
  retainer_hours    numeric(8,2),
  retainer_rollover boolean NOT NULL DEFAULT false,
  starts_on      date NOT NULL,
  due_on         date,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft','active','paused','delivered','closed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (tenant_id, status);
CREATE INDEX ON projects (tenant_id, client_id);
ALTER TABLE rate_cards ADD CONSTRAINT rate_cards_project_fk
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Who is on the project. Drives the "developer sees only their work" scope.
CREATE TABLE project_members (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_role text NOT NULL DEFAULT 'member' CHECK (project_role IN ('lead','member','observer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     int  NOT NULL DEFAULT 0,
  value_amount numeric(14,2),                         -- invoiceable on sign-off
  due_on       date,
  -- Client sign-off, with enough detail to settle a dispute later
  approved_at  timestamptz,
  approved_by  uuid REFERENCES users(id),
  approved_ip  inet,
  UNIQUE (project_id, position)
);

/* ============================================================================
   SALES: leads -> quotes -> projects
   ============================================================================ */

CREATE TABLE leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company       text NOT NULL,
  contact_name  text,
  email         citext,
  phone         text,
  source        text CHECK (source IN ('referral','inbound','outbound','event','marketplace','other')),
  est_value     numeric(14,2) NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'USD',
  probability   int NOT NULL DEFAULT 25 CHECK (probability BETWEEN 0 AND 100),
  stage         text NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new','qualified','proposal','negotiation','won','lost')),
  owner_id      uuid REFERENCES users(id),
  notes         text,
  next_follow_up date,
  -- Set when the lead converts, so a lead is never silently duplicated into a
  -- second client by someone converting it twice.
  client_id     uuid REFERENCES clients(id),
  lost_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON leads (tenant_id, stage, updated_at DESC);
CREATE UNIQUE INDEX leads_one_conversion ON leads (client_id) WHERE client_id IS NOT NULL;

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id),
  lead_id       uuid REFERENCES leads(id),
  number        text NOT NULL,
  title         text NOT NULL,
  description   text,
  currency      char(3) NOT NULL DEFAULT 'USD',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate      numeric(6,4) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  payment_terms text,
  expires_on    date,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired')),
  sent_at       timestamptz,
  viewed_at     timestamptz,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  decided_ip    inet,
  reject_reason text,
  -- One project per accepted quote. The unique index is what stops a second
  -- click on "create project" producing a duplicate.
  project_id    uuid REFERENCES projects(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ON quotes (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX quotes_one_project ON quotes (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE quote_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id     uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position     int NOT NULL DEFAULT 0,
  description  text NOT NULL,
  quantity     numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount  numeric(14,2) NOT NULL CHECK (unit_amount >= 0),
  -- A quote line becomes a milestone on acceptance when this is set, which is
  -- what makes quote -> project -> invoiceable milestones one continuous chain.
  is_milestone boolean NOT NULL DEFAULT true,
  amount       numeric(14,2) GENERATED ALWAYS AS (quantity * unit_amount) STORED
);
CREATE INDEX ON quote_lines (tenant_id, quote_id, position);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id) ON DELETE SET NULL,
  title        text NOT NULL,
  assignee_id  uuid REFERENCES users(id),
  estimate_hours numeric(8,2),
  status       text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('backlog','todo','doing','review','done','blocked')),
  priority     text NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','urgent')),
  position     int NOT NULL DEFAULT 0,        -- ordering within a kanban column
  description  text,
  reporter_id  uuid REFERENCES users(id),
  tags         text[] NOT NULL DEFAULT '{}',
  blocked_by   uuid REFERENCES tasks(id),     -- single-parent dependency, kept simple
  completed_at timestamptz,
  due_on       date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tasks (tenant_id, project_id, status, position);
CREATE INDEX ON tasks (tenant_id, project_id, status);
CREATE INDEX ON tasks (tenant_id, assignee_id) WHERE status <> 'done';

-- ============================================================================
-- 5. TIME ENTRIES — the ledger. Rates and FX are frozen at write time.
-- ============================================================================

CREATE TABLE time_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  worked_on   date NOT NULL,
  hours       numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  billable    boolean NOT NULL DEFAULT true,
  -- Non-billable time still costs money. Knowing which kind is how you fix it.
  category    text CHECK (category IN ('delivery','rework','internal','presales','admin','training')),
  note        text,

  -- ---- frozen at write time, never recalculated ----
  cost_rate_hour numeric(14,4) NOT NULL,   -- loaded cost/hr, home currency
  cost_currency  char(3)       NOT NULL,
  bill_rate_hour numeric(12,2),            -- client currency
  bill_currency  char(3),
  fx_rate        numeric(16,6) NOT NULL,   -- home -> base, on worked_on
  -- --------------------------------------------------

  invoice_id  uuid,
  locked_at   timestamptz,                 -- set when invoiced; blocks edits
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON time_entries (tenant_id, project_id, worked_on);
CREATE INDEX ON time_entries (tenant_id, user_id, worked_on);
CREATE INDEX ON time_entries (tenant_id, project_id) WHERE invoice_id IS NULL AND billable;

-- Generated columns keep the maths in one place instead of in six queries
ALTER TABLE time_entries
  ADD COLUMN cost_home numeric(16,4) GENERATED ALWAYS AS (hours * cost_rate_hour) STORED,
  ADD COLUMN cost_base numeric(16,4) GENERATED ALWAYS AS (hours * cost_rate_hour / fx_rate) STORED,
  ADD COLUMN value_base numeric(16,4) GENERATED ALWAYS AS
    (CASE WHEN billable THEN hours * COALESCE(bill_rate_hour, 0) ELSE 0 END) STORED;

-- Freeze the rates on insert so the application cannot forget to
CREATE OR REPLACE FUNCTION freeze_time_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t tenants%ROWTYPE; rc rate_cards%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tenants WHERE id = NEW.tenant_id;
  SELECT * INTO rc FROM rate_cards
    WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
      AND valid_from <= NEW.worked_on AND (valid_to IS NULL OR valid_to > NEW.worked_on)
      AND (project_id = NEW.project_id OR project_id IS NULL)
    ORDER BY project_id NULLS LAST LIMIT 1;
  IF rc.id IS NULL THEN
    RAISE EXCEPTION 'No rate card for user % on %', NEW.user_id, NEW.worked_on;
  END IF;

  NEW.cost_rate_hour := loaded_cost_per_hour(NEW.tenant_id, NEW.user_id, NEW.project_id, NEW.worked_on);
  NEW.cost_currency  := rc.cost_currency;
  NEW.bill_rate_hour := COALESCE(NEW.bill_rate_hour, rc.bill_rate);
  NEW.bill_currency  := rc.bill_currency;
  NEW.fx_rate := fx_on(rc.cost_currency, t.base_currency, NEW.worked_on);
  IF NEW.fx_rate IS NULL THEN
    -- Defaulting to 1 here would quietly report PKR figures as dollars.
    RAISE EXCEPTION 'No % -> % rate on or before %',
      rc.cost_currency, t.base_currency, NEW.worked_on;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_freeze_time_entry
  BEFORE INSERT ON time_entries
  FOR EACH ROW EXECUTE FUNCTION freeze_time_entry();

-- Invoiced time is immutable
CREATE OR REPLACE FUNCTION block_locked_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Time entry % is invoiced and cannot be changed', OLD.id;
  END IF;
  -- COALESCE(NEW, OLD), not NEW. In a BEFORE DELETE trigger NEW is NULL, and
  -- returning NULL from a BEFORE trigger *silently cancels the operation*. With
  -- plain `RETURN NEW` this guard quietly swallowed every delete of an unlocked
  -- entry: the API answered 200, the row survived, and it stayed billable.
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_block_locked BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION block_locked_entry();

-- ============================================================================
-- 6. SCOPE CHANGES — where fixed-bid margin actually dies
-- ============================================================================

CREATE TABLE change_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  est_hours     numeric(8,2) NOT NULL DEFAULT 0,
  price_amount  numeric(14,2) NOT NULL DEFAULT 0,     -- 0 = absorbed, i.e. given away
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','approved','rejected','absorbed')),
  raised_by     uuid REFERENCES users(id),
  approved_at   timestamptz,
  approved_by   uuid REFERENCES users(id),
  approved_ip   inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON change_orders (tenant_id, project_id, status);

-- ============================================================================
-- 7. EXPENSES & INVOICES
-- ============================================================================

CREATE TABLE expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  incurred_on date NOT NULL,
  description text NOT NULL,
  amount      numeric(14,2) NOT NULL,
  currency    char(3) NOT NULL,
  fx_rate     numeric(16,6) NOT NULL,                 -- frozen, same rule as time
  billable    boolean NOT NULL DEFAULT false,
  category    text,
  status      text NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_by uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  receipt_path text,
  invoice_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON expenses (tenant_id, project_id) WHERE status = 'approved';

COMMENT ON COLUMN expenses.fx_rate IS
  'Units of `currency` per one base-currency unit, frozen on the incurred date —
   same convention as time_entries.fx_rate. A USD expense in a USD-reporting
   tenant stores 1.';

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id),
  project_id    uuid REFERENCES projects(id),
  number        text NOT NULL,
  issued_on     date NOT NULL,
  due_on        date NOT NULL,
  currency      char(3) NOT NULL,
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  tax_label     text,                                 -- 'SRB 15%', 'Reverse charge', ...
  total         numeric(14,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','viewed','partially_paid','paid','overdue','void')),
  -- Set by trigger from the payments table, never typed. An invoice cannot be
  -- marked paid unless the money recorded against it actually adds up.
  amount_paid   numeric(14,2) NOT NULL DEFAULT 0,
  viewed_at     timestamptz,
  voided_at     timestamptz,
  void_reason   text,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  terms         text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (amount_paid >= 0),
  CHECK (total >= 0)
);
CREATE INDEX ON invoices (tenant_id, status, due_on);

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id),
  description  text NOT NULL,
  quantity     numeric(10,2) NOT NULL DEFAULT 1,
  unit_amount  numeric(14,2) NOT NULL,
  amount       numeric(14,2) GENERATED ALWAYS AS (quantity * unit_amount) STORED
);
ALTER TABLE time_entries ADD CONSTRAINT time_entries_invoice_fk
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

/* ============================================================================
   PAYMENTS

   An invoice's status is derived from the money recorded against it, never
   typed by a person. "Mark as paid" as a free-standing action is how an invoice
   ends up green in the system and unpaid in the bank.
   ============================================================================ */

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount       numeric(14,2) NOT NULL CHECK (amount <> 0),
  currency     char(3) NOT NULL,
  received_on  date NOT NULL DEFAULT current_date,
  method       text NOT NULL CHECK (method IN
                 ('bank_transfer','card','cash','wise','payoneer','stripe','paypal','other')),
  reference    text,                                  -- bank ref, txn id
  notes        text,
  -- A refund is a negative payment against the same invoice, so the running
  -- total stays correct and the history stays honest. Reversing by editing the
  -- original row would erase the fact that money moved twice.
  is_refund    boolean NOT NULL DEFAULT false,
  recorded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_refund AND amount < 0) OR (NOT is_refund AND amount > 0))
);
CREATE INDEX ON payments (tenant_id, invoice_id, received_on);

/* Recompute the invoice from its payments. Runs on every payment change. */
CREATE OR REPLACE FUNCTION recompute_invoice_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv invoices%ROWTYPE; paid numeric;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  SELECT COALESCE(sum(amount),0) INTO paid FROM payments WHERE invoice_id = inv.id;

  IF inv.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % is void and cannot take payments', inv.number;
  END IF;

  UPDATE invoices SET
    amount_paid = paid,
    status = CASE
      -- A rounding cent should not leave an invoice permanently unpaid.
      WHEN paid >= inv.total - 0.005 THEN 'paid'
      WHEN paid > 0                  THEN 'partially_paid'
      WHEN inv.due_on < current_date THEN 'overdue'
      WHEN inv.viewed_at IS NOT NULL THEN 'viewed'
      WHEN inv.status = 'draft'      THEN 'draft'
      ELSE 'sent'
    END
  WHERE id = inv.id;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_payment_rollup AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION recompute_invoice_status();

/* Overpayment is a real event (duplicate transfer, FX gain) and must be
   recordable — but not silently. The application surfaces it; the database
   only refuses payments against a void invoice, above. */

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Exactly one owner, enforced below: a document that belongs to everything
  -- belongs to nothing, and access control becomes guesswork.
  client_id    uuid REFERENCES clients(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
  task_id      uuid REFERENCES tasks(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id) ON DELETE CASCADE,
  invoice_id   uuid REFERENCES invoices(id) ON DELETE CASCADE,
  quote_id     uuid REFERENCES quotes(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text,
  byte_size    bigint,
  storage_path text NOT NULL,
  -- Whether the client portal may see it. Internal by default: a document that
  -- leaks to a client by default is a document that leaks.
  client_visible boolean NOT NULL DEFAULT false,
  checksum     text,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CHECK (num_nonnulls(client_id, project_id, task_id, milestone_id, invoice_id, quote_id) = 1)
);
CREATE INDEX ON documents (tenant_id, project_id);
CREATE INDEX ON documents (tenant_id, client_id);

/* ============================================================================
   INTEGRATIONS

   Third-party credentials. Access and refresh tokens are encrypted at rest with
   AES-256-GCM using a key from the environment, so a database dump alone does
   not hand an attacker a live Asana session for every customer.
   ============================================================================ */

CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('asana')),
  -- Ciphertext, never plaintext. See src/crypto.js.
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  -- Non-secret metadata: workspace name, connected account, chosen project.
  account_name  text,
  workspace_gid text,
  workspace_name text,
  config        jsonb NOT NULL DEFAULT '{}',
  connected_by  uuid REFERENCES users(id),
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_sync_at  timestamptz,
  last_error    text,
  UNIQUE (tenant_id, provider)
);

/* Maps an external record to one of ours. The unique index on the external id
   is what makes re-syncing idempotent: a second sync updates rather than
   duplicating, which is the failure that makes people distrust integrations. */
CREATE TABLE integration_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  entity        text NOT NULL CHECK (entity IN ('project','task','user','milestone')),
  external_id   text NOT NULL,
  internal_id   uuid NOT NULL,
  external_url  text,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, entity, external_id)
);
CREATE INDEX ON integration_links (tenant_id, provider, entity, internal_id);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (tenant_id, user_id, read_at, created_at DESC);


CREATE OR REPLACE FUNCTION invoice_balance(p_invoice uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT i.total - COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id = i.id), 0)
    FROM invoices i WHERE i.id = p_invoice
$$;

-- ============================================================================
-- 8. AUDIT LOG — who changed the contract value from 10k to 12k, and when
-- ============================================================================

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  actor_id    uuid,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('insert','update','delete')),
  before      jsonb,
  after       jsonb,
  ip          inet,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, entity, entity_id, at DESC);
CREATE INDEX ON audit_log (tenant_id, at DESC);
CREATE INDEX ON audit_log (tenant_id, actor_id, at DESC);

-- The log is append-only. Being able to edit the audit trail defeats the point
-- of having one, so the database refuses rather than trusting the application.
CREATE OR REPLACE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

CREATE OR REPLACE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (tenant_id, actor_id, entity, entity_id, action, before, after, ip)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    lower(TG_OP),
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    NULLIF(current_setting('app.ip', true), '')::inet
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- Everything that moves money, changes who can see money, or records a client
-- committing to something. Milestone approval and time entries were previously
-- missing, which is exactly backwards: those are the two records a dispute
-- actually turns on.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','rate_cards','invoices','invoice_lines','change_orders',
                           'milestones','time_entries','expenses','memberships','clients','tasks','payments',
                           'leads','quotes','documents','integrations']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION audit()', t);
  END LOOP;
END $$;

-- ============================================================================
-- 9. ROW-LEVEL SECURITY
--
-- The app opens each request with:
--     SET LOCAL app.tenant_id = '<uuid>';
--     SET LOCAL app.user_id   = '<uuid>';
--     SET LOCAL app.role      = 'developer';
-- and connects as a role that is NOT the table owner (owners bypass RLS).
-- ============================================================================

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION current_role_name() RETURNS text LANGUAGE sql STABLE AS
  -- Defaults to the least privileged role. An unset app.role must never fail open.
  $$ SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'developer') $$;

-- Role groupings live here and nowhere else. Nineteen policies repeating string
-- arrays is nineteen places to forget when a role is added.
CREATE OR REPLACE FUNCTION is_finance() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_role_name() IN ('admin','finance') $$;

-- Roles whose visibility is limited to projects they are staffed on.
CREATE OR REPLACE FUNCTION is_assigned_only() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_role_name() IN ('developer','designer','qa') $$;

CREATE OR REPLACE FUNCTION is_client_role() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_role_name() = 'client' $$;

-- Sees the whole delivery book, but not necessarily the money.
CREATE OR REPLACE FUNCTION is_internal_wide() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_role_name() IN ('admin','finance','sales','pm','lead') $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','projects','project_members','milestones','tasks',
                           'time_entries','change_orders','expenses','invoices',
                           'invoice_lines','payments','rate_cards','memberships','audit_log',
                           'leads','quotes','quote_lines','documents','notifications',
                           'integrations','integration_links']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) '
      'WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

-- Scoping on top of tenancy. Tenant isolation is the floor; these are the walls.
--
-- These MUST be AS RESTRICTIVE. Postgres combines permissive policies with OR,
-- so a permissive "developers see their own projects" policy does not narrow
-- anything — it widens, and any row where its condition happens to be true
-- becomes readable regardless of tenant. Restrictive policies AND together with
-- tenant_isolation, which is the behaviour you actually want. Getting this
-- wrong looks like working code and leaks every customer's salary data.

-- A client user sees only their own projects.
CREATE POLICY client_scope ON projects AS RESTRICTIVE FOR SELECT USING (
  NOT is_client_role()
  OR client_id = (SELECT client_id FROM memberships
                   WHERE user_id = current_user_id() AND tenant_id = current_tenant())
);

-- A developer sees only projects they are actually on.
CREATE POLICY assigned_scope ON projects AS RESTRICTIVE FOR SELECT USING (
  NOT is_assigned_only()
  OR EXISTS (SELECT 1 FROM project_members pm
              WHERE pm.project_id = projects.id AND pm.user_id = current_user_id())
);

-- A developer sees only their own time. Everyone else sees the team's.
CREATE POLICY own_time ON time_entries AS RESTRICTIVE FOR SELECT USING (
  NOT (is_assigned_only() OR is_client_role())
  OR user_id = current_user_id()
);

-- The tenants row itself. Without this the app role could read and update
-- every agency's billing settings, which rather undermines the rest.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

-- Raising and settling invoices is a finance action. Everyone else may read
-- them (subject to the policies below) and nobody else may write them.
CREATE POLICY invoice_insert ON invoices AS RESTRICTIVE FOR INSERT
  WITH CHECK (is_finance());
CREATE POLICY invoice_update ON invoices AS RESTRICTIVE FOR UPDATE
  USING (is_finance());
CREATE POLICY invoice_line_insert ON invoice_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (is_finance());

-- Milestone sign-off is the client's to give. The team can edit milestones,
-- but approval is the one field that means something legally, so a client
-- must be able to set it and a developer must not.
CREATE POLICY milestone_update ON milestones AS RESTRICTIVE FOR UPDATE
  USING (current_role_name() IN ('admin','pm','lead') OR is_client_role());

-- Everything hanging off a project inherits that project's visibility.
--
-- These EXISTS subqueries read `projects`, which is itself under RLS, so the
-- client and assignment rules above apply inside them. One policy per table
-- rather than restating the role logic five times and getting one of them
-- wrong. Without these, tenant isolation is the *only* wall on these tables:
-- a client could list every invoice in the agency, and a developer could log
-- time against a project she has never been staffed to.

CREATE POLICY inherits_project ON milestones AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = milestones.project_id));

CREATE POLICY inherits_project ON tasks AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id));

CREATE POLICY inherits_project ON change_orders AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = change_orders.project_id));

CREATE POLICY inherits_project ON time_entries AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = time_entries.project_id));

CREATE POLICY inherits_project ON expenses AS RESTRICTIVE FOR SELECT USING (
  CASE WHEN project_id IS NULL
       THEN NOT (is_client_role() OR is_assigned_only())
       ELSE EXISTS (SELECT 1 FROM projects p WHERE p.id = expenses.project_id) END);

-- An invoice is visible if its project is, and a client only ever sees their own.
CREATE POLICY inherits_project ON invoices AS RESTRICTIVE FOR SELECT USING (
  (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = invoices.project_id))
  AND (NOT is_client_role()
       OR client_id = (SELECT client_id FROM memberships
                        WHERE user_id = current_user_id() AND tenant_id = current_tenant())));

CREATE POLICY inherits_invoice ON invoice_lines AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id));

-- Sales objects. A client sees their own quotes (they have to, to accept one)
-- and nothing else; leads are internal and never client-visible.
CREATE POLICY sales_scope ON leads AS RESTRICTIVE FOR SELECT USING (
  NOT is_client_role() AND NOT is_assigned_only());

CREATE POLICY sales_scope ON quotes AS RESTRICTIVE FOR SELECT USING (
  CASE
    WHEN is_client_role() THEN client_id = (SELECT client_id FROM memberships
                                             WHERE user_id = current_user_id() AND tenant_id = current_tenant())
    WHEN is_assigned_only() THEN false        -- developers have no reason to see pricing
    ELSE true
  END);

CREATE POLICY inherits_quote ON quote_lines AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id));

-- Only sales and admin may create or reprice a quote.
CREATE POLICY quote_write ON quotes AS RESTRICTIVE FOR INSERT
  WITH CHECK (current_role_name() IN ('admin','sales','pm'));
CREATE POLICY quote_line_write ON quote_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (current_role_name() IN ('admin','sales','pm'));
-- A client may update a quote only to decide on it; the column-level rule that
-- they can change nothing else is enforced in the API handler.
CREATE POLICY quote_update ON quotes AS RESTRICTIVE FOR UPDATE
  USING (current_role_name() IN ('admin','sales','pm') OR is_client_role());
CREATE POLICY lead_write ON leads AS RESTRICTIVE FOR ALL
  USING (current_role_name() IN ('admin','sales','pm'))
  WITH CHECK (current_role_name() IN ('admin','sales','pm'));

-- Documents inherit whatever they hang off, and a client sees only those
-- explicitly marked visible to them.
CREATE POLICY doc_scope ON documents AS RESTRICTIVE FOR SELECT USING (
  (NOT is_client_role() OR client_visible)
  AND (
    (project_id   IS NOT NULL AND EXISTS (SELECT 1 FROM projects p   WHERE p.id = documents.project_id))
 OR (client_id    IS NOT NULL AND EXISTS (SELECT 1 FROM clients c    WHERE c.id = documents.client_id))
 OR (task_id      IS NOT NULL AND EXISTS (SELECT 1 FROM tasks t      WHERE t.id = documents.task_id))
 OR (milestone_id IS NOT NULL AND EXISTS (SELECT 1 FROM milestones m WHERE m.id = documents.milestone_id))
 OR (invoice_id   IS NOT NULL AND EXISTS (SELECT 1 FROM invoices i   WHERE i.id = documents.invoice_id))
 OR (quote_id     IS NOT NULL AND EXISTS (SELECT 1 FROM quotes q     WHERE q.id = documents.quote_id))
  ));

-- Integration credentials are admin-only. A developer with read access to this
-- table would hold a live Asana token for the whole company.
CREATE POLICY integration_admin ON integrations AS RESTRICTIVE FOR ALL
  USING (current_role_name() = 'admin') WITH CHECK (current_role_name() = 'admin');
-- The links are harmless metadata and drive UI badges, so they follow the
-- ordinary internal-visibility rule.
CREATE POLICY integration_links_scope ON integration_links AS RESTRICTIVE FOR SELECT
  USING (NOT is_client_role());

-- Soft-deleted documents disappear for everyone.
CREATE POLICY doc_not_deleted ON documents AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL);
-- Clients may not upload into internal scopes, and never mark anything visible
-- to themselves that the agency has not shared.
CREATE POLICY doc_insert ON documents AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT is_client_role());
CREATE POLICY doc_update ON documents AS RESTRICTIVE FOR UPDATE
  USING (NOT is_client_role());

-- Notifications are strictly personal to *read*, but any action can create one
-- for somebody else — that is the entire point of a notification. A single FOR
-- ALL policy requiring user_id = current_user_id() silently blocks every write
-- to another person, which surfaces as the originating business action failing
-- rather than as a missing notification.
CREATE POLICY own_notifications_read ON notifications AS RESTRICTIVE FOR SELECT
  USING (user_id = current_user_id());
CREATE POLICY own_notifications_update ON notifications AS RESTRICTIVE FOR UPDATE
  USING (user_id = current_user_id());
CREATE POLICY own_notifications_delete ON notifications AS RESTRICTIVE FOR DELETE
  USING (user_id = current_user_id());
-- Inserts are constrained by tenant_isolation above: you may notify anyone in
-- your own tenant, and nobody outside it.
CREATE POLICY notify_others ON notifications AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m
                       WHERE m.user_id = notifications.user_id
                         AND m.tenant_id = current_tenant() AND m.is_active));

CREATE POLICY inherits_invoice ON payments AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = payments.invoice_id));
CREATE POLICY payment_insert ON payments AS RESTRICTIVE FOR INSERT WITH CHECK (is_finance());
CREATE POLICY payment_update ON payments AS RESTRICTIVE FOR UPDATE USING (is_finance());
CREATE POLICY payment_delete ON payments AS RESTRICTIVE FOR DELETE USING (is_finance());

-- Writing time: you may only log your own hours, and only to a project you are
-- actually staffed on. SELECT policies do nothing to stop an INSERT, so this
-- needs saying separately or the write path has no wall at all.
CREATE POLICY own_time_insert ON time_entries AS RESTRICTIVE FOR INSERT WITH CHECK (
  user_id = current_user_id()
  AND EXISTS (SELECT 1 FROM project_members pm
               WHERE pm.project_id = time_entries.project_id
                 AND pm.user_id = current_user_id()));

CREATE POLICY own_time_update ON time_entries AS RESTRICTIVE FOR UPDATE USING (
  user_id = current_user_id()
  -- finance included: invoicing hourly work locks the entries it bills
  OR current_role_name() IN ('admin','pm','lead') OR is_finance());

CREATE POLICY own_time_delete ON time_entries AS RESTRICTIVE FOR DELETE USING (
  user_id = current_user_id());

-- Rate cards are the most sensitive table in the database. Three roles, no more.
CREATE POLICY rate_card_read ON rate_cards AS RESTRICTIVE FOR SELECT USING (
  is_finance()
  OR user_id = current_user_id()          -- you may always see your own
);

-- ============================================================================
-- 10. REPORTING VIEWS
-- ============================================================================

-- Live project economics. This is the product.
--
-- effective_rate divides recognised revenue by hours, not billed value by
-- hours. On a fixed bid those are very different numbers: the bill rates say
-- what you hoped to earn per hour, the contract says what you will actually
-- be paid. A job quoted too low looks fine by the first measure right up to
-- the day it is delivered.
CREATE OR REPLACE VIEW project_margin AS
SELECT q.*, CASE WHEN q.hours > 0 THEN q.revenue_base / q.hours END AS effective_rate
FROM (
SELECT
  p.tenant_id,
  p.id AS project_id,
  p.name,
  p.client_id,
  p.billing_type,
  p.contract_value,
  p.target_margin,
  COALESCE(t.hours, 0)                                   AS hours,
  COALESCE(t.billable_hours, 0)                          AS billable_hours,
  COALESCE(t.cost_base, 0) + COALESCE(x.cost_base, 0)    AS cost_base,
  COALESCE(t.cost_home, 0)                               AS cost_home,
  COALESCE(m.done::numeric / NULLIF(m.total, 0), 0)      AS progress,
  CASE p.billing_type
    WHEN 'hourly' THEN COALESCE(t.value_base, 0)
    ELSE p.contract_value * COALESCE(m.done::numeric / NULLIF(m.total, 0), 0)
  END                                                    AS revenue_base,
  p.contract_value * (1 - p.target_margin)               AS budget_cost,
  COALESCE(t.value_base, 0)                              AS billed_value
FROM projects p
LEFT JOIN LATERAL (
  SELECT sum(hours) hours,
         sum(hours) FILTER (WHERE billable) billable_hours,
         sum(cost_base) cost_base, sum(cost_home) cost_home, sum(value_base) value_base
    FROM time_entries WHERE project_id = p.id
) t ON true
LEFT JOIN LATERAL (
  -- Approved only: a submitted-but-unapproved claim is not yet a cost.
  SELECT sum(amount / fx_rate) cost_base FROM expenses
   WHERE project_id = p.id AND NOT billable AND status = 'approved'
) x ON true
LEFT JOIN LATERAL (
  SELECT count(*) total, count(*) FILTER (WHERE approved_at IS NOT NULL) done
    FROM milestones WHERE project_id = p.id
) m ON true
WHERE p.status IN ('active','paused','delivered')
) q;

-- Utilisation: billable hours against contracted capacity, last 30 days.
CREATE OR REPLACE VIEW utilisation_30d AS
SELECT
  ms.tenant_id, ms.user_id, u.full_name, ms.role, ms.employment,
  COALESCE(sum(te.hours), 0)                                   AS hours,
  COALESCE(sum(te.hours) FILTER (WHERE te.billable), 0)        AS billable_hours,
  ms.weekly_hours * 30 / 7                                     AS capacity_hours,
  COALESCE(sum(te.hours) FILTER (WHERE te.billable), 0)
    / NULLIF(ms.weekly_hours * 30 / 7, 0)                      AS utilisation,
  COALESCE(sum(te.value_base) - sum(te.cost_base), 0)          AS contributed_base
FROM memberships ms
JOIN users u ON u.id = ms.user_id
LEFT JOIN time_entries te
  ON te.user_id = ms.user_id AND te.tenant_id = ms.tenant_id
 AND te.worked_on >= current_date - 30
WHERE ms.is_active AND ms.role <> 'client'
GROUP BY ms.tenant_id, ms.user_id, u.full_name, ms.role, ms.employment, ms.weekly_hours;

-- Work delivered but never invoiced.
CREATE OR REPLACE VIEW unbilled AS
SELECT tenant_id, project_id,
       sum(hours)      AS hours,
       sum(value_base) AS value_base
  FROM time_entries
 WHERE billable AND invoice_id IS NULL
 GROUP BY tenant_id, project_id
HAVING sum(value_base) > 0;

-- ============================================================================
-- Deliberately NOT in V1, and that is the point:
--   attendance, leave, payroll, appraisals, knowledge base, meeting recordings,
--   transcripts, sales pipeline, proposals, contracts, SSO, custom branding.
-- Add them when 50 agencies are paying, not before.
-- ============================================================================
