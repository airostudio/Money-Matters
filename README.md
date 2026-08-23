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

1. Create a Supabase project and set **one** Vercel project env var:
   `DATABASE_URL` = the Session pooler connection string. It needs enough
   privilege to create tables/roles/RLS policies; the default `postgres`
   role has it.

   Two things that will otherwise cost you a deploy cycle: replace the
   `[YOUR-PASSWORD]` placeholder with the real password, and make sure the
   variable is enabled for the **environment you actually deploy** —
   a preview branch does not read Production-scoped variables.
2. Deploy. `npm run build` runs `npm run db:migrate:ci` first (see
   `db:migrate:ci` below), which applies the schema and Row-Level Security
   policies to that database using Vercel's own copy of `DATABASE_URL` —
   this repo's migration tooling never needs that value handed to it any
   other way. The **first** successful build also generates a random
   password for the restricted `mm_app` role (see `docs/security.md`) and
   prints the resulting connection string once, to that deployment's own
   build log — nowhere else.
3. Open that build's log, copy the printed connection string, and in
   Vercel: keep the admin string as `DIRECT_DATABASE_URL` (migrations use
   it), and set `DATABASE_URL` to the printed `mm_app` connection string.
   The app's runtime traffic must not use the admin connection — a table
   owner is exempt from row-level security, so that configuration disables
   tenant isolation (see `docs/security.md` §2).

   Prefer not to have a password sitting in a build log? Set
   `MM_APP_DB_PASSWORD` to a value you choose and redeploy — the migration
   applies it without printing anything, and you build `DATABASE_URL`
   yourself. This is also how to recover if the printed password was missed:
   it is applied on every run, so it resets `mm_app` to a known value.

   On a **pooled** Supabase connection the username is not plain `mm_app` —
   Supavisor routes by `<role>.<project-ref>`, so it is
   `mm_app.<project-ref>`, matching the `postgres.<project-ref>` in your
   admin string. The migration prints the correct form.
4. Redeploy. From then on, every build's migration step is a no-op if
   there's nothing new to apply, and it never touches `mm_app`'s password
   again once that role has `LOGIN` enabled — a redeploy won't silently
   invalidate the `DATABASE_URL` you just set.

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
