# Money Matters

The financial operating system for business — an AI-assisted accounting
platform combining accounting, banking, payroll, tax, billing, expenses,
inventory, projects, and forecasting in one product.

Phase 1 (Financial Foundation), Phase 2 (banking — bank import/
reconciliation/rules plus AI-assisted fuzzy reconciliation, Document AI
receipt/invoice capture, employee expense claims), Phase 3 (sales —
customer invoicing & AR core plus quotes, recurring invoicing, and a
deterministic Collection Priority Score), and Phase 4 (purchases —
supplier bills & Accounts Payable core plus purchase orders with
three-way matching, recurring bills, supplier credits, and payment runs
with segregation-of-duties approval) are all complete, each as a core
slice plus one extension slice, and Phase 5 (Reporting) has two slices:
Profit & Loss, Balance Sheet, and a Cash Flow Statement (indirect method),
each with comparison periods, CSV export, and drill-down from every line
down to its source invoice/bill/expense claim; plus dimensional reporting
(tag a journal line with a project/location/department and filter any
report by it), a configurable Report Builder (rows/columns/measures/
filters/comparison periods, saved as personal or organization-wide
queries that always re-run against fresh data), natural-language
reporting (ask a plain-English question — Claude translates it into a
structured query, the same deterministic report-builder engine computes
the answer, it never calculates anything itself), and an on-demand
management report pack (all three statements plus a short AI commentary).
Phase 6 Slice 1 adds the AI Financial Controller — a conversational
assistant over a fixed set of read-only, permission-checked tools (trial
balance, P&L, balance sheet, aged receivables/payables, invoice/bill/
expense-claim lookup, and the report builder) — and an on-demand Daily
Finance Brief (cash position, money in/out due in the next 7 days, overdue
receivables/payables, payments awaiting approval). Phase 6 Slice 2 adds an
org-level AI autonomy setting (master spec §8; Level 0/1 information-only
by default, Level 2 "prepare" an explicit opt-in), three write-capable
tools that PREPARE — never create or post — a draft invoice, bill, or
journal entry, always behind a separate, explicit human confirmation step
before anything is written to the database, and four specialist agent
modes (Bookkeeping, AR, AP, FP&A) as scoped tool subsets/system prompts
over the same Controller loop. Phase 6 Slice 3 extends the autonomy
setting to the full 0-4 range: Levels 3-4 let the AI auto-execute (no
confirmation click) a narrow, organization-whitelisted set of actions —
auto-generating a due recurring invoice/bill, or auto-confirming an exact,
same-day bank reconciliation match — while supplier payments, bank
details, payroll, tax, unusual journals, and period closes stay
human-gated at every level, with no exception. Phase 7 Slice 1 adds
Projects/Jobs & Time Tracking: projects with a budget and a default billing
rate, flat per-project tasks, a start/stop timer and manual time entry on
the same underlying row, a single-approver submit/approve/reject workflow,
and the integration master spec §23 asks for — "create invoice from
unbilled time" pulls approved, billable, not-yet-invoiced hours straight
into a draft invoice through the exact same `InvoiceService.create` path as
any other invoice, marking each entry INVOICED so a second run can never
double-bill it — plus a live Estimated-vs-Actual project profitability view
computed from posted invoice/bill/expense-claim lines, never cached data.
Phase 7 Slice 2 adds a scoped-down Inventory core: a product catalog
(tracked-inventory vs. non-inventory/service items sharing one catalog and
line-item UI), single-location perpetual weighted-average costing — buying
stock via a bill recomputes the average cost, selling stock via an invoice
posts COGS in the SAME journal entry as the sale's revenue (never a
separate periodic process), an oversell is always refused rather than
back-ordered, manual stock adjustments always post a journal and require a
reason, an Inventory Valuation report that reconciles exactly against the
GL's own inventory-asset balance, and deterministic reorder-point
alerting. Multi-warehouse tracking, FIFO costing, serial/lot tracking,
landed costs, bundles/kits, and sales-velocity stockout forecasting are
explicitly deferred — see `docs/roadmap.md` for the full list and why.
Phase 7 Slice 3 — the last piece of Phase 7 — adds Fixed Assets: an asset
register (asset classes as simple depreciation-default templates, assets
registered either standalone or from a posted bill line already coded to
the asset account — the register itself never posts the acquisition, since
whichever path was used already did), on-demand straight-line depreciation
runs (one combined journal per calendar month, idempotent per asset per
period — running the same month twice never double-posts), and one-way
disposal/write-off that recognizes a gain or loss via the normal posting
path. A Fixed Asset Register report reconciles exactly against the GL, the
same correctness-check discipline as inventory's valuation report.
Declining-balance and other depreciation methods, asset-transfer workflows,
and automatic/scheduled depreciation runs are explicitly deferred — see
`docs/roadmap.md` for the full list and why.

Phase 8 Slice 1 adds the AU payroll foundation: an effective-date-controlled
tax/super rule engine (two seeded financial years, FY2025-26 and
FY2026-27, with every rate/threshold verified against ato.gov.au and cited
in the data itself), employee records with TFN/bank details handled like a
password (redacted from the audit log, masked to last-4 for any role
without `employee:manage`), PAYG withholding via the ATO's acknowledged
annualized-bracket approximation method, superannuation guarantee with the
quarterly contribution-base cap correctly tracked across pay runs, NES
annual/personal leave accrual, on-demand DRAFT-then-POST pay runs that post
one combined journal through `PostingService`, and an STP Phase 2-shaped
report that is clearly labelled as never actually submitted to the ATO.
Payday Super's FY2026-27 mechanics and the ATO's published NAT 1004
per-period coefficient tables were explicitly left unresolved rather than
guessed at — see `docs/roadmap.md` for the full, honest list of what was
verified vs. deferred, and note that a registered tax agent or payroll
provider should verify this software's output before it is used for real
employee payroll.

Phase 9 Slice 1 adds the budgeting core: baseline/revised-forecast/
rolling-forecast budgets with monthly line items by GL account (optionally
scoped to a dimension value), a Budget vs. Actual report built on the
exact same GL-aggregation query every other financial statement uses (so
it reconciles correctly, including an account with a budget line and no
actual activity, or actual activity with no budget line), an on-demand
rolling-forecast action that copies a budget's lines forward from a
chosen cutoff date, and a real Budget vs. Actual section in the
Management Report Pack.

Phase 9 Slice 2 adds cash flow intelligence and scenario modelling. The
Cash Forecast projects your cash balance 7/30/60/90 days and 12 months out
as TWO separate series — known commitments only (open invoices and bills,
payment runs, recurring templates) and including statistical projections
(simple averages like a customer's own historical lateness) — and warns,
with a date, when either dips below a threshold you set. Scenarios model
hiring someone, changing prices, or losing a customer as Best / Expected /
Worst built from explicit, editable assumptions (never predictions). Both
are analysis only and never post to the ledger; the AI Financial Controller
gains a read-only `cash_forecast` tool.

Phase 9 Slice 3 adds the Month-End Close workspace and the period-lock
override workflow. Periods carry a lock level (open, soft, advisor, tax,
hard); a soft lock can be posted into inline by an accountant-level role with a
recorded reason, tax and hard locks only through the audited reopen workflow
(reason required; only an owner or administrator can reopen those), and every
lock change is appended to a history table the application role cannot edit.
`/accounting/close` shows a live checklist per month — bank reconciliation,
draft documents, depreciation, inventory and fixed-asset reconciliation, trial
balance and Balance Sheet checks, suspense accounts — plus manual sign-offs that
are always labelled as a person's attestation, never system verification.
Closing is human-only: the AI Financial Controller gains a read-only
`close_status` tool but no way to close, lock or reopen anything.

Phase 9 Slice 4 adds multi-entity accounting and consolidation. A user who
belongs to several organizations can build an *entity group* (up to 10
entities) and view a consolidated Profit & Loss, Balance Sheet and cash
position at `/app/groups`, with a column per entity, a combined column, an
eliminations-and-adjustments column and the consolidated total; drill-down
lands on each entity's own account page. Intercompany accounts are matched with
a named counterparty and eliminated, and any mismatch is reported rather than
forced to zero. Consolidation never weakens row-level security: it is computed
in the application, one entity at a time, using the user's real role in each
entity — an entity they cannot read is left out and reported as "N entities
excluded — no access", including from the AI Financial Controller's new
read-only `consolidated_report` tool. A topbar switcher lets a multi-company
user jump between companies. Groups of mixed base currencies are refused (no
translation yet).

Phase 9 Slice 5 adds accountant practice management and workpapers, which
**closes out Phase 9**. Any registered user can set up a *practice* at
`/practice` (partner / manager / staff roles) and link client organizations
through a two-sided handshake: the practice proposes by organization slug and
the client's owner or administrator accepts — and can revoke at any moment,
effective on the very next read. A link grants no access by itself; staff read
a client only as real members of it, with their own role there, one client at a
time. The practice dashboard (Client | Books | Reconciliation | BAS/Tax |
Payroll | Issues | Assigned to | Snapshot age, worst first, 10 per page) is read
from saved snapshots that a Refresh updates sequentially, so it stays inside the
database connection budget. Also built: client groups, staff assignment, bulk
actions, practice tasks, a tax calendar of rules the practice writes itself (no
ATO dates are hardcoded and there is no BAS/GST feature yet), client queries and
document requests that appear in the client's own "Requests from your
accountant" inbox, and digital workpapers (balance-sheet account
reconciliation with an exact-decimal difference, evidence, review notes,
preparer and reviewer sign-off with segregation of duties, immutability once
signed off, and carry-forward) that never write to the client's ledger. A
Business | Accountant toggle changes terminology and shows the Practice entry
points (presentation only), and the AI Financial Controller gains read-only
`practice_overview` and `workpaper_status` tools. See `docs/security.md` §13
and `docs/roadmap.md`.
See
[`docs/roadmap.md`](docs/roadmap.md) for exactly what's built
vs. explicitly deferred in each phase (a customer portal, AI-drafted
collection reminders, a live bank feed provider, Stripe, a background job
queue, a Redis cache, real bank-file/payment-rail integration, full
inventory-backed goods receiving, PDF/Excel export, and a configurable
fiscal-year start all need either infrastructure that doesn't exist yet,
external accounts/credentials this environment doesn't have, or are next up
on top of what's built so far).
See [`docs/architecture.md`](docs/architecture.md) for how it's put
together.

## Stack

Next.js 14 (App Router) · TypeScript (strict) · Tailwind CSS · PostgreSQL ·
Drizzle ORM · NextAuth · Vitest + fast-check

## Getting started

Requires Node 20+ and a local PostgreSQL 16 server.

```bash
npm install
cp .env.example .env   # then fill in real values
```

### Database

Create two databases and copy `.env.example` → `.env`, filling in
connection strings for both (see the comments in that file for why there
are two roles per database — RLS/tenant isolation, see
[`docs/security.md`](docs/security.md) §2):

```bash
createdb money_matters
createdb money_matters_test
npm run db:migrate   # applies drizzle/*.sql, incl. RLS policies + the mm_app role
```

### Seed a demo company (optional but recommended)

```bash
npm run db:seed
```

Seeds **Northstar Electrical Group** — a demo Australian electrical
contractor with a full chart of accounts, tax codes, fiscal periods,
contacts, and ~28 realistic journal entries (including a reversed one).
Prints a login URL and password at the end.

### Run it

```bash
npm run dev
```

Visit `http://localhost:3000` — register a new organization, or sign in
with the seeded demo credentials.

## Deploying (Vercel + Supabase)

The app runs against plain PostgreSQL, so any Postgres works — this
section covers the specific Vercel + Supabase path.

> **Use the Session pooler connection string, not the direct one.**
> Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only unless you
> pay for the IPv4 add-on, and Vercel's builds and functions are IPv4-only —
> so the direct string fails there no matter how correct the password is.
> In Supabase: Project Settings → Database → Connection string → **Session
> pooler** (host looks like `aws-0-<region>.pooler.supabase.com`, user looks
> like `postgres.<project-ref>`). `npm run db:doctor` warns about this
> explicitly if you get it wrong.

Set **three** environment variables on the Vercel project, for every
environment you deploy (Production *and* Preview — a preview branch does not
read Production-scoped variables):

| Variable | Value |
|---|---|
| `DIRECT_DATABASE_URL` | The Supabase **Session pooler** connection string (admin role). Migrations use it. |
| `MM_APP_DB_PASSWORD` | Any password you choose for the restricted `mm_app` role. Alphanumeric avoids all URL-encoding questions. |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32`. Keep it stable — changing it invalidates every session. |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated emails allowed into the platform admin section (`/admin`) — for this deployment `typhoon.tall69@gmail.com`. Compared case-insensitively. **Unset or empty means nobody is an admin.** Register that account yourself first: there is no email verification (see `docs/security.md` §10). |

Leave `DATABASE_URL` **unset**. The application's connection is derived from
`MM_APP_DB_PASSWORD` plus the host and database in `DIRECT_DATABASE_URL`, so
the password exists in exactly one place. Setting it in two — the role and a
hand-written `DATABASE_URL` — is the single most common way to get a green
build where every request fails with `password authentication failed`.

Set `DATABASE_URL` explicitly only if the app must reach the database
differently from migrations. Its host, port and database are used as given,
but while `MM_APP_DB_PASSWORD` is set the role and password are always
`mm_app`'s: an admin connection string here would run the whole application
with row-level security disabled, so it is redirected rather than honoured,
with a warning in the build log saying so.

Optionally, set `ANTHROPIC_API_KEY` to turn on every AI-assisted feature in
this codebase: the onboarding wizard's chart-of-accounts classification,
AI-assisted fuzzy bank reconciliation, Document AI receipt/invoice
extraction, natural-language reporting, the management report pack's
commentary, the AI Financial Controller, and the Daily Finance Brief's
summary paragraph (see `docs/ai-agents.md`). All of these are entirely
optional — with it unset, each falls back silently (a deterministic
classifier, no AI suggestions section, a blank draft to fill in manually,
"natural-language reporting/the AI Financial Controller isn't available
right now", no commentary/summary paragraph) with no loss of core
functionality and no network call:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | An Anthropic API key. Server-side only — never exposed to the client. |
| `ANTHROPIC_ONBOARDING_MODEL` | Defaults to `claude-haiku-4-5-20251001` if unset. |
| `ANTHROPIC_RECONCILIATION_MODEL` | Defaults to `claude-haiku-4-5-20251001` if unset. |
| `ANTHROPIC_DOCUMENT_AI_MODEL` | Defaults to `claude-sonnet-4-5-20250929` if unset (vision extraction benefits from a stronger model than the other two classification-only calls). |
| `ANTHROPIC_NL_REPORTING_MODEL` | Defaults to `claude-haiku-4-5-20251001` if unset. |
| `ANTHROPIC_MANAGEMENT_PACK_MODEL` | Defaults to `claude-haiku-4-5-20251001` if unset. |
| `ANTHROPIC_CONTROLLER_MODEL` | Defaults to `claude-sonnet-4-5-20250929` if unset (the Financial Controller's multi-turn tool-use reasoning benefits from a stronger model than the single-shot classification calls above). |
| `ANTHROPIC_DAILY_BRIEF_MODEL` | Defaults to `claude-haiku-4-5-20251001` if unset. |

Deploy. `npm run build` runs `npm run db:migrate:ci` first, which applies the
schema and RLS policies, provisions the `mm_app` role, and then **connects
with the application's own credentials to prove they work** — so a
misconfiguration is named in the build log rather than discovered as a 500.
A healthy build log looks like:

```
[db] Migrating postgres at aws-0-….pooler.supabase.com:5432 as "postgres.…"
[db] Migrations complete.
[db] mm_app password set from MM_APP_DB_PASSWORD.
[db] Tenant isolation audit: 12 of 16 tables are organization-scoped, and all have FORCEd row-level security with a policy.
[db] Application will connect … as "mm_app.…" (from derived from MM_APP_DB_PASSWORD + DIRECT_DATABASE_URL)
[db] Verified: the application can connect as "mm_app".
```

The audit line is not decoration: adding a table is one line in
`src/db/schema.ts`, while giving it a policy, `FORCE`, and an `mm_app` grant
are three separate edits in a migration. Forgetting any of them raises no
error — the table simply becomes invisible to the application, or visible to
every tenant at once. The audit names either the first time it happens.

`npm run db:seed` seeds Northstar Electrical Group the same way against any
target database — point `DATABASE_URL`/`DIRECT_DATABASE_URL` at it locally
and run the script; it isn't wired into the Vercel build.

### Deployment settings live in `vercel.json`

`vercel.json` pins the framework preset (`nextjs`), build command and install
command in version control. Vercel's dashboard settings can override
auto-detection, and if the preset drifts to "Other" the build succeeds and
then fails with `No Output Directory named "public" found` — Vercel looks
for a static site rather than picking up `.next`. Keeping these in the repo
means the deployment config is reviewable and can't silently change.

### When a connection won't work

```bash
npm run db:doctor
```

Reports every connection-string variable it can see, whether each parses,
what host/user/database/SSL it resolves to, and whether it can actually
connect — with the password redacted throughout. It names the specific
problem (unsubstituted placeholder, stray quotes or whitespace, wrong
scheme, IPv6-only Supabase host, bad password, missing database) instead of
the driver's bare `TypeError: Invalid URL`. Run it locally against a copy of
the failing value, or as a one-off command in your host's shell.

Note that `next build` no longer needs a reachable database — only the
migration step does — so a connection problem can never break the app build
itself.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Run the test suite once (`test:watch` for watch mode) |
| `npm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations (owner connection), loading `.env` |
| `npm run db:migrate:ci` | Same, but reads `process.env` directly (no `.env` file) — what `npm run build` runs first, so it works on Vercel |
| `npm run db:doctor` | Diagnose the database connection without changing anything (`db:doctor:ci` reads `process.env` directly) |
| `npm run db:studio` | Drizzle Studio, a DB browser |
| `npm run db:seed` | Seed the Northstar Electrical Group demo company |

## Testing

```bash
npm test
```

Unit tests (`src/tests/unit`) need no database. Property-based tests
(`src/tests/property`, using `fast-check`) and integration tests
(`src/tests/integration`) run against `TEST_DATABASE_URL` /
`TEST_DIRECT_DATABASE_URL` — point these at a disposable database, never
one with real data; the suite truncates it between tests.

The integration suite includes a tenant-isolation test that proves Postgres
Row-Level Security blocks cross-organization reads and writes even when
application code forgets a filter — see
[`docs/security.md`](docs/security.md) and
[`src/tests/integration/tenant-isolation.test.ts`](src/tests/integration/tenant-isolation.test.ts).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system architecture
- [`docs/accounting-engine.md`](docs/accounting-engine.md) — the double-entry posting engine's invariants
- [`docs/database.md`](docs/database.md) — schema conventions, RLS, a Drizzle/Postgres pitfall worth reading before touching money-bearing queries
- [`docs/security.md`](docs/security.md) — tenant isolation, auth, threat model
- [`docs/ai-agents.md`](docs/ai-agents.md) — the AI layer's architecture: the AI Financial Controller foundation (Phase 6 Slice 1), the autonomy-level gate, prepare/confirm write tools, and specialist-agent modes (Phase 6 Slice 2), and the full 0-4 autonomy dial with whitelisted auto-execution, undo, and an emergency stop (Phase 6 Slice 3). Payroll/Tax specialist agents are not yet built — see that doc and `docs/roadmap.md` for why
- [`docs/roadmap.md`](docs/roadmap.md) — phase-by-phase status
- [`docs/decisions/`](docs/decisions/) — ADRs for the non-obvious technical calls

## Platform admin and seat limit

- `/admin` (platform dashboard, organization/user directory, seat-limit and
  plan-tier controls, member role changes, user suspension, admin audit log)
  is visible only to the email(s) in `PLATFORM_ADMIN_EMAILS`; everyone else
  gets a 404. It reads platform-level tables only and never any customer's
  books. Details: `docs/security.md` §10, `docs/roadmap.md`.
- Each account (organization) can currently be shared by **2 people** (its
  `seat_limit`); more will be a paid add-on later. A platform admin can raise
  an organization's limit from `/admin/organizations/<id>`.
