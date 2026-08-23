# Security

## 1. Threat model summary

This is a multi-tenant SaaS holding financial records, PII, and (in later
phases) bank/payment credentials. The two failure modes that matter most:
**cross-tenant data leakage** and **unauthorized financial action** (a
payment, a payroll change, a bank-detail edit). Everything below is designed
around preventing those two things specifically, not generic hardening.

## 2. Tenant isolation

Enforced at two independent layers (defense-in-depth — either layer alone
failing must not cause a leak):

1. **Application layer.** `src/db/tenant.ts` exposes `forOrg(orgId)` which
   returns a scoped repository; there is no code path in `src/domain/**`
   that queries a tenant table without an explicit `organizationId` derived
   from the authenticated actor's active membership.
2. **Database layer.** PostgreSQL RLS policies (see `docs/database.md` §3)
   scope every tenant table to `app.current_org_id`, set from the session
   inside the request's transaction — never trusted from client input.

**Test**: `src/tests/integration/tenant-isolation.test.ts` creates two
organizations, seeds one with accounts/journals, authenticates as a member
of org A only, and asserts every read/write path (service methods and, once
routes exist, HTTP handlers) returns nothing / rejects for org B's data —
including when an org B id is guessed and passed explicitly. This test is
part of the required-green suite for every PR that touches `src/db/**` or
`src/domain/**`.

**Row-level security is FORCED, not merely enabled.** PostgreSQL exempts a
table's *owner* from its own RLS policies unless `FORCE ROW LEVEL SECURITY`
is set (`drizzle/0002_force_row_level_security.sql`). Without FORCE, pointing
the application's `DATABASE_URL` at the same admin connection the migrations
use silently disables tenant isolation entirely — no error, no log line, and
the app appears to work perfectly. Verified empirically: with a non-superuser
owner, `ENABLE` alone returned a tenant row on an unscoped query, and adding
`FORCE` returned none.

FORCE does *not* constrain superusers or roles with `BYPASSRLS` — nothing at
the table level can. That residual gap is covered two other ways: the
application connects as `mm_app`, which is neither, and `npm run db:migrate`
prints a loud warning if the runtime and migration connections resolve to the
same role. `src/tests/integration/tenant-isolation.test.ts` asserts every
tenant table has RLS both enabled *and* forced, so a future table cannot be
added without it.

**The `mm_app` role's credential never touches source control.**
`drizzle/0001_row_level_security.sql` creates `mm_app` with `NOLOGIN` and no
password — deliberately: a fixed password on a role with real database
privileges, committed to a public repo, is a genuine vulnerability the
moment it runs against an internet-reachable database (`mm_app` can set
`app.current_org_id` to any value, so a leaked password is a cross-tenant
read of the entire database). `src/db/migrate.ts` sets a real password
immediately after that migration runs: `MM_APP_DB_PASSWORD` if the
environment provides one (local dev pins this so `.env`'s connection
strings stay valid across re-migrations), otherwise a freshly generated
one, printed once to that process's own stdout and never stored anywhere
else — so a Vercel deployment's build log is the only place it appears,
not a chat transcript or a committed file. It's a no-op on every
subsequent run once `mm_app` already has `LOGIN` enabled, so a redeploy
never silently rotates a password another environment depends on.

## 3. AuthN / AuthZ

- **Phase 1 auth**: NextAuth Credentials provider, `bcrypt`-hashed
  passwords, JWT sessions (no database-backed session table — see
  `docs/decisions/0002-auth-strategy.md`). MFA/passkey (WebAuthn) is
  architected for (session model supports multiple credential types) but
  not implemented in Phase 1 — tracked in `docs/roadmap.md`.
- **AuthZ**: RBAC via `MembershipRole` on `OrganizationMembership`, checked
  by `assertPermission(actor, permission, org)` in
  `src/domain/permissions/`. UI-level hiding of controls is a courtesy, not
  a control — every mutation is re-checked server-side regardless of what
  the client rendered.
- **Passwords**: `bcrypt` with a work factor of 12, never stored or logged
  in plaintext; audit logs never capture password fields (`AuditService`
  redacts by field-name denylist before persisting `before`/`after` JSON).

## 4. AI permission parity (forward-looking, enforced by construction)

No AI agent exists in Phase 1. The reason this still belongs in the Phase 1
security doc: the domain-service choke point (`assertPermission` called
*inside* the service, before any repository access) is what makes "the AI
can never see what the user's role can't see" true later without a second,
parallel permission system to keep in sync. When Phase 6 adds AI tool calls,
they call the same `AccountService`/`LedgerService` methods a human request
calls — permissions are checked once, in one place, for both.

## 4a. Database transport (TLS) — a known gap

`resolveConnection` (see `docs/database.md` §2b) enables TLS for every
non-local database host. Without a CA to check the server certificate
against, it uses `rejectUnauthorized: false`: the channel is **encrypted but
not authenticated**, which stops passive interception but not an active
machine-in-the-middle attacker who can already redirect traffic.

Set `DATABASE_CA_CERT` to the provider's CA certificate to get full
verification (`rejectUnauthorized: true`). Doing that for the production
database is a **required step before this platform holds real financial
data**, and is tracked as such in `docs/roadmap.md` — it is deliberately not
silently defaulted on, because a wrong or missing CA fails closed and would
take the whole application down rather than degrade.

Connection strings are treated as credentials throughout: they are never
logged in full, only via `redactConnectionString()`.

## 5. Transport & storage

- All traffic HTTPS (enforced at the hosting layer — Vercel).
- Secrets (`DATABASE_URL`, `NEXTAUTH_SECRET`, future provider API keys) via
  environment variables only, never committed; `.env.example` documents
  required keys with placeholder values.
- No service-role/admin DB credentials are ever sent to the client. Prisma
  runs server-side only (`src/db/client.ts` is never imported from a
  `"use client"` module — enforced by ESLint's `no-restricted-imports` for
  client components).

## 6. Application-layer protections (Phase 1 baseline)

- **CSRF**: NextAuth's built-in CSRF token on auth flows; state-changing
  Server Actions rely on Next.js's same-origin enforcement for actions.
- **XSS**: React's default escaping; no `dangerouslySetInnerHTML` in
  accounting UI. Content-Security-Policy header set in `next.config.ts`.
- **SQL injection**: Prisma parameterizes all queries; the only hand-written
  SQL in the repo is the RLS policy DDL in migrations, which contains no
  user input.
- **Rate limiting / brute force / suspicious login detection**: deferred —
  requires the Redis-compatible cache/queue infra introduced in Phase 2;
  tracked in `docs/roadmap.md` as a Phase 2 item, not silently skipped.

## 7. Audit trail as a security control

Every mutation to accounts, journals, memberships/roles, and contacts is
recorded via `AuditService` (append-only, no update/delete grant on
`AuditLog` for the application's runtime role). This is both a compliance
requirement (master spec §44) and a security control: it is how a
cross-tenant or privilege-escalation bug would be detected in review.

## 8. Payment & banking security (not yet applicable)

No payment provider, bank feed, or stored financial credential exists in
Phase 1. When Phase 2 (Smart Banking) and Phase 3/4 (payments) land, they
must follow master spec §51-52 (tokenization via external providers only,
never storing card/bank credentials; supplier bank-detail changes trigger
alerts and preserve previous details; segregation of duties on payment
batches). Documented here now so it is not forgotten later.
