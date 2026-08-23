# Money Matters

The financial operating system for business — an AI-assisted accounting
platform combining accounting, banking, payroll, tax, billing, expenses,
inventory, projects, and forecasting in one product.

This repository is at **Phase 1: Financial Foundation** — see
[`docs/roadmap.md`](docs/roadmap.md) for what's built and what's next, and
[`docs/architecture.md`](docs/architecture.md) for how it's put together.

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
- [`docs/ai-agents.md`](docs/ai-agents.md) — the AI layer's architecture (not yet implemented)
- [`docs/roadmap.md`](docs/roadmap.md) — phase-by-phase status
- [`docs/decisions/`](docs/decisions/) — ADRs for the non-obvious technical calls
