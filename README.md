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

1. Create a Supabase project and set **one** Vercel project env var:
   `DATABASE_URL` = the project's direct connection string (port `5432`,
   the `postgres` user — the one shown on Supabase's Database settings
   page). This needs to have enough privilege to create tables/roles/RLS
   policies; the default `postgres` role does.
2. Deploy. `npm run build` runs `npm run db:migrate:ci` first (see
   `db:migrate:ci` below), which applies the schema and Row-Level Security
   policies to that database using Vercel's own copy of `DATABASE_URL` —
   this repo's migration tooling never needs that value handed to it any
   other way. The **first** successful build also generates a random
   password for the restricted `mm_app` role (see `docs/security.md`) and
   prints the resulting connection string once, to that deployment's own
   build log — nowhere else.
3. Open that build's log, copy the printed connection string, and in
   Vercel: rename the current `DATABASE_URL` to `DIRECT_DATABASE_URL`
   (migrations keep using this), and set `DATABASE_URL` to the printed
   `mm_app` connection string instead (the app's actual runtime traffic
   should never use the admin connection — RLS is bypassed for it).
4. Redeploy. From then on, every build's migration step is a no-op if
   there's nothing new to apply, and it never touches `mm_app`'s password
   again once that role has `LOGIN` enabled — a redeploy won't silently
   invalidate the `DATABASE_URL` you just set.

`npm run db:seed` seeds Northstar Electrical Group the same way against any
target database — point `DATABASE_URL`/`DIRECT_DATABASE_URL` at it locally
and run the script; it isn't wired into the Vercel build.

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
