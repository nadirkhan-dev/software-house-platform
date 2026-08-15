# Marginly — software house management platform

Multi-tenant platform for development agencies: leads through to cash, with
project profitability derived from real cost rather than typed in.

**Status: the complete business workflow works end to end, in a browser.**
Sections 6 and 7 are candid about what is built, what is partial, and what is
not started. Please read them before planning around this.

---

## Requirements

- Node.js 20 or newer
- PostgreSQL 15 or newer

Frontend is React + Vite + TypeScript, built into `public/` and served by the
same Express process — one port in production, no reverse proxy required.

## Installation

```bash
tar -xzf software-house-platform-final.tar.gz
cd marginly
npm install          # server dependencies
npm run build        # installs and builds the React client into public/

createdb marginly
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
DATABASE_URL=postgres://localhost/marginly
SESSION_SECRET=<paste the output of: openssl rand -hex 32>
```

The app **will not start** without a real `SESSION_SECRET`, and rejects values
that look like placeholders. That is deliberate: a default secret works
perfectly in every environment, so nobody notices it reached production, and
anyone who has read the source can forge a session for any user in any tenant.

## Database

```bash
npm run migrate    # schema, RLS policies, triggers, the unprivileged `app` role
npm run seed       # two agencies of realistic demo data
npm run reset      # both, from scratch (destructive)
```

`npm run seed` refuses to run against a database that already has data.

## Development

```bash
npm start          # server only, serving the built client — http://localhost:3000
npm run dev        # API on :3000 + Vite with hot reload on :5173
```

In development, use **http://localhost:5173**. Vite proxies `/api` to Express so
the session cookie stays same-origin and CSRF keeps working.

## Testing

```bash
npm test           # 108 tests across 6 files
```

The suite starts its own server if one is not already running. It is built to be
run repeatedly against the same database: everything it creates is torn down,
and the seeded data is byte-for-byte identical afterwards.

## Production

```bash
npm run build                  # type-check and bundle the client
NODE_ENV=production npm start
```

`NODE_ENV=production` enables HSTS and marks cookies `secure`, so terminate TLS
in front of the app. `npm run build` runs `tsc --noEmit` first — a type error
fails the build rather than shipping.

---

## Demo accounts

Local development only. Password for all: `marginly`


**Lahore Labs** — a second agency, to demonstrate isolation

| Email | Role |
|---|---|
| `rehan@lahorelabs.pk` | admin |
| `ap@acme.example` | client |

**Platform**

| Email | Role |
|---|---|
| `ops@marginly.app` | platform staff — tenant provisioning only, no company data |

Sign in as each in turn. The differences are not cosmetic; they are different
rows coming out of PostgreSQL.

---

## 1. The workflow, in the browser

All of this is verified working. Walk it yourself:

1. **Pipeline** (`ayesha@kdc.pk`) — five leads across six stages. Move one
   along, or **Convert** it to a client.
2. **Quotes** — a draft quote. **Send** it.
3. Sign out; sign in as `procurement@northwind.example` → **Quotes** →
   **Accept**. The decision is timestamped, attributed and IP-logged.
4. Back as admin — the accepted quote offers **Create project**. Each quote line
   becomes a milestone; the contract value is the quote total.
5. **Tasks** — a kanban board across five columns. Move cards between them.
6. **Timesheet** — log hours. Cost is frozen at that day's rate card and
   exchange rate, by database trigger.
7. **Expenses** — submit one; finance approves it and it immediately counts
   against project margin.
8. **Projects** → open a milestone → **Approve** (as the client).
9. **Invoices** → the approved milestone appears under **Ready to invoice** →
   **Draft invoice**. The time it bills is locked.
10. **PDF** → a real invoice PDF. **Send** it.
11. **Record payment** → part of the balance. Status becomes *part paid*.
12. Record the remainder → *paid*, derived from the payment records.
13. **Dashboard** → margin reflects labour cost, expenses and revenue.
14. **Reports** → revenue against cost by month, project and client
    profitability, invoice ageing, team utilisation. Every figure derived.

Along the way: press **`/`** anywhere to search, click the **bell** to see what
needs your attention, and the **half-moon** to switch to dark mode.

## 2. Business rules enforced in the database

Not in the UI, and not only in the API:

- A milestone is not invoiceable until the client has approved it.
- An approved milestone cannot be billed twice — invoice lines carry
  `milestone_id`, and the next draft excludes anything already claimed.
- Billed time is locked and cannot be edited.
- **An invoice becomes paid only when payment records add up to its total.**
  There is no "mark as paid" endpoint; status is computed by trigger from the
  `payments` table.
- A void invoice cannot take payments; an invoice with payments cannot be voided
  until they are refunded.
- A refund is a negative payment, never an edit to the original — so the ledger
  shows money arriving and leaving.
- A developer cannot approve a milestone or accept a quote as the client.
- A quote produces at most one project (partial unique index).
- A lead converts to a client exactly once (partial unique index).
- Tenant A cannot read or write anything belonging to Tenant B.

## 3. Security

**Two independent layers.** The database decides which rows exist; the API
decides which fields are serialised. The interesting failures are the ones where
a developer remembers one and forgets the other, so both are tested.

- Row-level security on 18 tables, `FORCE`d, with the app connecting as a
  non-owner role — table owners bypass RLS, so an app running as owner would
  have every policy silently disabled while appearing to work perfectly.
- Scoping policies are `AS RESTRICTIVE`. Postgres combines permissive policies
  with `OR`, so a permissive "developers see their own projects" policy *widens*
  access rather than narrowing it.
- Platform administration is a flag on `users`, not a tenant role. Those
  accounts never receive a tenant context, so RLS returns nothing for them.
- CSRF double-submit tokens; the session is a cookie, so this is required.
- Login throttling per IP **and** per account — keying only on IP lets one
  attacker lock out everyone behind a shared NAT.
- Input validation (zod) at the boundary, with field-level errors.
- CSP, HSTS, `nosniff`, `frame-ancestors: none`, no `X-Powered-By`.
- Audit log across 12 tables, append-only at the database level.
- Notifications are readable only by their recipient, but any action may create
  one for a colleague — split into separate SELECT/INSERT policies, because a
  single `FOR ALL` policy silently blocked the originating business action.
- RLS denials answer **404**, not 403 or 500 — a 403 confirms the record exists.

## 4. Test results

```
108 tests · 108 passing · 0 failing
```

| File | Covers |
|---|---|
| `test/acceptance.test.js` | the whole workflow, lead to paid, in order |
| `test/tenancy.test.js` | cross-tenant isolation, through the HTTP API |
| `test/security.test.js` | secrets, CSRF, throttling, validation, headers, audit |
| `test/api.test.js` | roles, redaction, margin engine, invoicing, notifications, search, reports |
| `test/modules.test.js` | token encryption, upload safety, documents, settings, integrations, email |
| `test/dates.test.js` | week boundaries and DATE handling, pinned across five timezones |

Run twice consecutively against the same database: 108/108 both times, with
`time_entries`, `invoices`, `documents` and `users` counts identical before and
after. The invoice, document and user counts are fixed at 9/6/18; the time
entry count is not a constant — the seed lays down weekdays relative to the day
it runs, so it lands near 1180 and moves with the calendar. What matters is
that it is unchanged across a run, not what the number is.

The suite also passes under `TZ=Asia/Karachi` and `TZ=Pacific/Midway` with no
`TZ` set anywhere in configuration. That is deliberate: a DATE is a calendar day
and must not depend on where the server happens to be. `test/dates.test.js`
runs its timezone-sensitive assertions in child processes so the property is
checked rather than assumed from whatever zone CI happens to use.

## 5. Browser test results

Driven with Playwright at 1440×1000, with console and page errors captured.

| Flow | Result |
|---|---|
| Admin login → dashboard → all nine sections | pass, no page errors |
| Pipeline: six stages render; lead converts to client | pass |
| Quotes: draft → send | pass |
| Client login → accepts a $43,000 quote | pass |
| Tasks: five columns, cards move between them | pass |
| Expenses: approve, cost appears in margin | pass |
| Invoices: draft → PDF → send | pass |
| Payment modal: partial payment recorded, status → *part paid* | pass |
| Permission lens: developer sees no financial figures anywhere | pass |
| Global search: results, keyboard navigation, `/` shortcut | pass |
| Reports: 12-month chart, profitability, ageing, utilisation | pass |
| Dark mode: every screen, both themes | pass |
| Notifications: approval → finance's bell shows 1 unread | pass |
| React app: sign-in, all 12 routes, no page errors | pass |
| Quick-create (⌘K): created a real lead, landed on the pipeline | pass |
| Documents: upload, download, share with client, delete | pass |
| Settings: company, users and roles, integrations tabs | pass |
| Responsive: 390×844 mobile viewport | pass |
| Production build: `tsc --noEmit` clean, 85KB gzipped | pass |

---

## 6. What is built

Everything in the original brief. Phase by phase:

| Phase | Status |
|---|---|
| 0 — Security & foundation | Complete |
| 1 — React / Vite / TypeScript frontend | Complete |
| 2 — Projects, tasks, time, milestones, expenses, payments, invoices, PDFs | Complete |
| 3 — CRM, leads, quotes, quote PDFs, quote → project | Complete |
| 4 — Client portal, documents, notifications, search, reports, settings | Complete |
| 5 — Asana OAuth, email delivery, production config | Complete |

### The frontend

React 18, Vite 6, TypeScript in strict mode with `noUncheckedIndexedAccess`.
TanStack Query for server state, React Router for routing. The build runs
`tsc --noEmit` first, so a type error fails the build rather than shipping.

Redaction is enforced by the type system: fields the server omits by permission
are optional in `lib/types.ts`, so the compiler makes you handle the absent case
rather than rendering a zero where a figure was withheld.

Bundle: 283KB raw, **85KB gzipped**. No component library — the design system is
about 26KB of CSS carried over from the version that was already tested in a
browser, so dark mode is variables-only and survives the migration untouched.

### Asana

Real OAuth 2.0 against the tenant's own organisation — authorize, exchange,
refresh on expiry, list workspaces and projects, import tasks. Deliberately not
a personal access token pasted into a box: that carries one employee's
permissions and breaks the day they leave.

Sync is idempotent, keyed on Asana's `gid` in `integration_links`, so running it
twice updates rather than duplicating. Assignees match on email; an unmatched
one leaves the task unassigned rather than guessing, because silently assigning
work to the wrong person is worse than a blank.

Tokens are encrypted at rest with AES-256-GCM (`src/crypto.js`) using a key from
the environment, so a database dump alone does not hand over a live session for
every tenant. GCM authenticates as well as encrypts: a tampered ciphertext
throws instead of decrypting to garbage that something downstream treats as a
token.

### Email

Real nodemailer. Three transports, chosen by environment: SMTP when `SMTP_URL`
is set, an in-memory outbox under `NODE_ENV=test`, and a clearly-marked
`[email:not-sent]` log otherwise. The third is the honest option for a laptop —
it proves the template rendered without pretending a message left the building.

Ten templates. Recipients are BCC so one does not learn the others. Sending
never blocks or fails a business write: a mail server being down must not stop
an invoice being raised.

### Documents

Streaming upload with an allow-list of types, a 25MB ceiling, SHA-256 checksums
and generated storage keys. The uploaded filename is metadata only — it is
attacker-controlled input, and `../../etc/passwd` is a thing people send.
Downloads are `Content-Disposition: attachment`, so an SVG or HTML file cannot
run script against our own origin.

`client_visible` is off by default. A document that reaches a client by default
is a document that leaks.

The storage driver is three methods — put, stream, remove — so swapping local
disk for S3 or R2 is one file rather than a refactor.

## 7. Notes for whoever runs this

- **Rate limiting is in-process.** Move it to Redis before running more than one
  instance, or the effective limit multiplies by the instance count. The store
  is behind an interface for exactly this.
- **The FX series is seeded.** Replace it with a real feed on a nightly job.
- **Storage is local disk.** Point `STORAGE_DIR` at a mounted volume, or write
  the S3 driver against the same three methods.
- **`audit_log` is append-only but not replicated.** Back it up separately.
- **`ENCRYPTION_KEY` should be separate from `SESSION_SECRET`.** It falls back
  if unset, but then rotating your session secret makes every stored OAuth token
  undecryptable.

### Filters, views and preview

Three items the brief called for explicitly, added last:

**Report filters** (brief §3 and Phase 5: date range, client, project, team
member). One filter builder shared by all five report queries — five
hand-written WHERE clauses drift apart the first time someone adds a sixth
report. Malformed input is discarded rather than passed to SQL, and because the
queries still run on the RLS-scoped connection a filter can only ever *narrow*
what the caller could already see. The project dropdown narrows to the chosen
client, so the two cannot be set to a combination that returns nothing.

**Task calendar** (brief §8: list, kanban, calendar). A month grid keyed on due
date, Monday-first, with today outlined, priority on the left edge of each pill
and overdue in crimson. Tasks with no due date are listed below rather than
hidden — an undated task is usually a planning gap, not something to disappear.
All three views share one filter.

**Document preview** (brief §19: "preview where possible"). Rendered in a
sandboxed iframe from an endpoint that serves only inert types — PDFs, raster
images and plain text. SVG and HTML are refused for preview and download
instead: served inline from our own origin they would run script against a
logged-in session, which is stored XSS with extra steps. Text is forced to
`text/plain` so a `.md` or `.csv` cannot be sniffed as markup, and the response
carries its own restrictive CSP.

Out of scope, and named here so it is not mistaken for an oversight:

- **Document version chains.** Not in the brief. Uploading the same filename
  creates a new record; there is no version history or rollback.

## 8. Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Not a superuser — owners bypass RLS |
| `SESSION_SECRET` | yes | 32+ random bytes; the app refuses to boot without it |
| `PORT` | no | Defaults to 3000 |
| `NODE_ENV` | no | `production` enables HSTS and secure cookies |
| `ENCRYPTION_KEY` | no | Encrypts OAuth tokens at rest. Falls back to `SESSION_SECRET` |
| `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` | no | From an Asana admin; server-side only |
| `ASANA_REDIRECT_URI` | no | Must match the app registered in Asana |
| `SMTP_URL` / `MAIL_FROM` | no | Without these, notifications stay in-app |
| `APP_URL` | no | Used in notification emails to link back |
| `STORAGE_DIR` | no | Defaults to `./storage` |
| `MAX_UPLOAD_BYTES` | no | Defaults to 25MB |
| `RATE_LIMIT_DISABLED` | no | Local load testing only |
| `NO_LISTEN` | no | Set to `1` to import the server without binding a port |
| `TZ` | no | Not needed. DATE columns are read as calendar days, so the app is correct in any zone — see below |

`.env` is read by `src/env.js`, which runs before anything else in the process.
Real environment variables always win, and a missing `.env` is fine: a container
or systemd unit that configures purely through the environment is the normal
case, not an error.

**On timezones.** The app does not require `TZ`. `src/db.js` registers a type
parser so a Postgres `DATE` arrives as `'YYYY-MM-DD'` rather than a JS `Date` at
local midnight — without it, `2026-06-01` serialises as `2026-05-31` anywhere
east of UTC and billable hours land in the previous month with nothing failing
to say so. Setting `TZ=UTC` also hides that, but a deployment that forgets the
variable is silently wrong again; a type parser cannot be forgotten.

Run the **database** with `timezone = UTC` regardless. `DATE` arithmetic is
unaffected, but `current_date` and `now()` are not, and a server whose idea of
today differs from the database's will bucket a timesheet into the wrong week.

## 9. External credentials you must provide

**Asana** — the app works fully without this; Settings → Integrations simply
reports it as unavailable.

1. An Asana admin creates an app at `https://app.asana.com/0/my-apps`.
2. Set the redirect URL there to match `ASANA_REDIRECT_URI`, e.g.
   `https://your-host/api/integrations/asana/callback`.
3. Put the client id and secret in the **server** environment. Neither ever
   reaches the browser — the authorize URL is built server-side and the secret
   is used only in the token exchange.
4. If your organisation requires a Service Account, an Asana super admin must
   create it and supply those credentials instead. Do **not** use a personal
   access token belonging to an employee: it carries their permissions and
   stops working the day they leave.

Then: Settings → Integrations → Connect Asana, pick a project, and sync.

**SMTP** — any provider. Without `SMTP_URL`, notifications appear in-app only
and outbound mail is logged as `[email:not-sent]` rather than silently dropped.

Nothing else. No API keys are embedded anywhere in the source.

## 10. Commands

```bash
npm install                    # dependencies
npm run reset                  # migrate + seed (destructive)
npm start                      # http://localhost:3000
npm test                       # 108 tests
NODE_ENV=production npm start  # production
```
