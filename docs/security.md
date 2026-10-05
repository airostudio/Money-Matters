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
the table level can, and on Supabase the `postgres` role has `BYPASSRLS`, so
an admin connection defeats FORCE as well as ENABLE. That residual gap is
closed at the point the connection is built rather than by policy:
`resolveConnection("runtime")` rewrites the connection's role to `mm_app`
whenever `MM_APP_DB_PASSWORD` is set, so an admin `DATABASE_URL` cannot put
the application on a privileged role even by accident. This is not a
hypothetical: it happened in this project's own deployment, where
`DATABASE_URL` was repointed at the admin connection to get past an
authentication failure, and every subsequent request ran with isolation off.
The rewrite is announced as a warning, never done silently, and unsetting
`MM_APP_DB_PASSWORD` opts out.

Two checks make a future regression visible instead of latent:

- `npm run db:migrate` audits every table after migrating and warns about any
  table carrying `organization_id` without RLS enabled, without `FORCE`, or
  without a policy — and about any table `mm_app` cannot read. Adding a table
  is one line in `src/db/schema.ts`; the policy, the FORCE and the grant are
  three separate edits elsewhere, and forgetting any of them raises no error
  on its own.
- `src/tests/integration/tenant-isolation.test.ts` asserts every tenant table
  has RLS both enabled *and* forced.

`organization_memberships` is the one table with an `organization_id` and no
policy, and it is exempt by name rather than by omission: it is the join that
*answers* "which organizations is this user in?", so a policy keyed on
`app.current_org_id` would make the lookup that establishes the current
organization depend on it already being established. Isolation for it is
enforced in the application layer — a session only ever reads its own
memberships — and covered by the tenant-isolation suite.

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

## 9. Phase 8 Slice 1 — TFN and bank-detail handling

A Tax File Number (TFN), stored on `employees.tfn`, is treated with the
same sensitivity as a password throughout this codebase:

- **Never logged, never in a full-value audit snapshot**: `AuditService`'s
  `REDACTED_FIELDS` set includes `tfn`, `bankAccountNumber`, and `bankBsb`
  alongside `password`/`passwordHash`/`secret`/`token` — any audit-log
  before/after snapshot that would otherwise include one of these fields
  gets `[redacted]` instead, enforced centrally in `AuditService.record`,
  not left to each call site to remember.
- **Never placed on a read for a role without `employee:manage`**:
  `EmployeeService.get`/`list` only ever put the real `tfn` value on the
  returned view when the calling actor's role holds `employee:manage`
  (checked structurally, the same `assertPermission` call every other
  permission check in this codebase uses — see
  `src/domain/payroll/employee-service.ts`'s `roleCanManage` helper). A
  role with only `employee:read` (ACCOUNTANT, BOOKKEEPER — see
  `src/domain/permissions/roles.ts`) always receives `tfn: null` and must
  use `tfnMasked` (last-4 digits, via `src/domain/payroll/
  sensitive-data.ts`'s `maskLast4`) instead. The UI never has access to an
  unmasked value it could accidentally render to a lesser-privileged role —
  the masking happens in the service layer, before the value ever reaches
  a page.
- **Bank account number** (`employees.bankAccountNumber`) gets the same
  treatment — masked to last-4 for any read, redacted in the audit log —
  though it is a lower-sensitivity field than a TFN; this slice applies the
  stricter TFN-equivalent handling to both rather than drawing a finer
  distinction.
- **Record-keeping only**: storing a TFN and bank details does not imply
  any real integration — there is no SuperStream remittance and no real
  bank-file payment generation in this codebase (see
  `docs/roadmap.md`'s Phase 8 Slice 1 entry), so these fields carry no
  transmission risk beyond their storage in this database, which the
  controls above address.

## 10. Platform admin section and seat limit

The platform admin section (`/admin`) is the operator's console: platform
business metrics, an organization/user directory, seat-limit/plan-tier and
member-role controls, user suspension, and an admin audit log. It is **not** a
back door into customer books — see the boundary below.

### 10.1 The identity gate

- **Source of truth**: the server-side environment variable
  `PLATFORM_ADMIN_EMAILS` (comma-separated). It is never hardcoded in source,
  never sent to the client, and not part of the session payload. For this
  deployment it is `typhoon.tall69@gmail.com`.
- **Fails closed**: unset, empty, whitespace-only or commas-only means *nobody*
  is a platform admin (`parsePlatformAdminEmails` returns an empty set; the
  gate and every service refuse).
- **Normalised comparison**: both sides go through `normalizeEmail` (trim +
  lowercase), the same function registration, sign-in and add-member use.
- **The email compared is the database's, not the token's**: the JWT only
  carries the user id. `getCurrentUser()` re-reads the user row on each request
  (see 10.3), so a forged/stale token claim cannot supply an admin email.
- **One gate, used everywhere**: `requirePlatformAdmin()`
  (`src/lib/platform-admin.ts`) is called by the admin layout, **every** admin
  page, the CSV export route handler and **every** server action — server
  actions are directly invocable, so the layout alone is not a control. A
  structural test asserts every `page|route|actions` file under `src/app/admin`
  references it. Non-admins (signed-in ordinary users, suspended admins and
  signed-out visitors) get `notFound()` — a **404**, never a 403 or a
  redirect — so the section's existence isn't revealed. (`src/middleware.ts`
  deliberately lets `/admin` through so a signed-out visitor sees a 404, not a
  redirect to `/login`; it performs no authorisation itself.)
- **Defence in depth**: every `PlatformAdminService` / `MetricsService` /
  `DirectoryService` / `PlatformAuditService` / `ExportService` method takes the
  caller's user id and re-verifies it against the database
  (`verifyPlatformAdmin`: active user, stored email in the list) before doing
  anything, so the domain layer refuses a non-admin even if a caller forgot the
  page-level gate. Tests invoke every service method and every server action as
  an ordinary user and as a signed-out visitor and assert refusal and no change.
- **The admin link** is rendered only by a server component
  (`isPlatformAdminUser`) and passed to the user menu as a boolean; for everyone
  else the link is simply absent from the HTML. Nothing about admin status is
  in the JWT or session.
- **A platform admin is not a tenant member.** Being an admin grants no
  organization membership, no role in any organization, and no tenant data
  access whatsoever. (They can still belong to organizations as an ordinary
  user, with ordinary roles.)

### 10.2 The no-email-verification caveat and the case-variant mitigation

This app has **no email-verification step**: anyone can register any
address. For a single-email gate that is the crux. What was found: registration
already lowercased the email before checking/inserting, but the database's
`users_email_unique` index was a plain **case-sensitive** index, and nothing
stopped other write paths (a seed script, direct SQL, a future code path) from
storing a mixed-case address — so `Typhoon.Tall69@gmail.com` could in principle
have coexisted with `typhoon.tall69@gmail.com`. Also `addMemberByEmail` looked
users up with the raw, un-normalised string.

Fix (migration `0035_platform_admin_and_seat_limit.sql`, `UserService`):

- Emails are normalised on write in `UserService.register`, and
  `addMemberByEmail` / `verifyCredentials` normalise on lookup.
- The database enforces it: `CHECK (email = lower(btrim(email)))`
  (`users_email_normalised`) **and** a unique index on `lower(email)`
  (`users_email_lower_unique`). A second account differing only by case/whitespace
  is impossible, including via direct SQL; a unique-violation race between two
  simultaneous registrations surfaces as the normal "already registered" error.
- The migration first checks for existing case-duplicates and **aborts naming
  them** rather than merging or deleting anything; it then normalises
  mixed-case rows in place. (The local development and test databases had none; check production before deploying.)

**Residual risk (be honest about it):** because there is no email
verification, the first person to register `typhoon.tall69@gmail.com` owns that
account and, with `PLATFORM_ADMIN_EMAILS` set to it, is the platform admin. The
real owner must therefore register that address **before** the variable is set
in production (or immediately after, checking the user directory shows exactly
one such account). There is also no MFA: the admin account is protected only by
its password (bcrypt, no rate limiting beyond the platform's). **Recommended
follow-ups, in priority order: (1) email verification, at minimum for the
platform admin address; (2) MFA/passkey for the admin account; (3) login rate
limiting.** Until then a single email on an unverified credentials login is the
weakest link in the platform's security.

### 10.3 Suspended users and session cut-off

`users.disabled_at` marks a suspended user. Two mechanisms:

1. **Sign-in is refused** (`UserService.verifyCredentials` returns `null`, the
   same result as a wrong password — no account-state oracle).
2. **Already-issued sessions stop working.** NextAuth JWT sessions are
   self-contained (docs/decisions/0002-auth-strategy.md), so blocking sign-in
   alone would leave an existing token valid until it expires. Instead
   `getCurrentUser()` (`src/lib/session.ts`) — which every page, layout, server
   action, `requireOrgAndActor`, `requireActor`, `getActorForOrganization` and
   the admin gate go through — does one primary-key lookup of the user row
   (`UserService.getActiveIdentity`) per request and returns `null` for a
   suspended or deleted user. It is wrapped in React's per-request `cache`, so a
   layout and its page cost one query, not two, and it is a single sequential
   query (no fan-out — the Supabase pooler lesson in `src/db/client.ts`).
   **Latency: the user's very next request** (not "eventually"/on token expiry).
   Limitation: `src/middleware.ts` runs on the edge and only checks that a token
   exists; a suspended user with a stale token can therefore still *load* a
   route's shell, but every data/auth lookup returns "not signed in" and the
   layouts redirect to `/login`. No data is served.
3. An admin cannot suspend themselves (enforced in the service, not just hidden
   in the UI). Suspending an admin also revokes their admin access immediately.

### 10.4 The strict non-tenant boundary

The admin section reads and writes **only** `users`, `organizations`,
`organization_memberships` and its own `platform_admin_audit_logs`. It never
reads a tenant-scoped table (invoices, journals, accounts, employees, payroll,
bank data, ...) for any purpose, including metrics; the only tenant table it
ever *writes* is the affected organization's own `audit_logs`, through
`AuditService.recordPlatformAction` inside `withTenant(org.id)`. It never uses a
privileged/owner connection (the app only ever connects as `mm_app`) and there is
**no impersonation / "log in as user" feature**. Enforced structurally by
`src/tests/unit/platform-admin/boundary.test.ts`: admin modules may import only
the allow-listed non-tenant schema symbols, may not name any
`organization_id`-bearing table (ts or raw SQL), may only import allow-listed
domain modules, and may not open their own DB connection.

The admin domain code is **not** AI-accessible: no Financial Controller tool
references it, a test asserts the tool registry (read and write tools) contains
nothing admin-related, and another asserts no `ai-controller` module imports
`platform-admin`.

### 10.5 Admin audit trail

Every admin write (plan/seat-limit change, role change, member removal,
suspend/reactivate, and even a directory CSV export) writes a row to
`platform_admin_audit_logs` (admin user id **and email snapshot**, action,
target type/id, target organization, before/after, metadata) in the **same
transaction** as the change. The table has no `organization_id` column (it is a
platform table, deliberately outside the tenant-isolation audit) and `mm_app`
holds `SELECT, INSERT` only — `UPDATE`, `DELETE` and `TRUNCATE` are denied at the
database, verified in a test using the real restricted role. Organization-
affecting actions additionally write an entry to that organization's own
`audit_logs` (actor type `SYSTEM`, no user id, so customers see "the platform"
rather than the admin's identity; `metadata.platformAdmin = true` and the
matching `platformAuditId`) so customers can see their seat limit, a role or a
membership was changed by the platform. Suspension is user-level (a user spans
organizations), so it is recorded in the platform log only.

### 10.6 Seat limit

`organizations.seat_limit` (default 2) caps **active** memberships — a seat is
one active `organization_memberships` row; there is no invitation concept (a
member can only be attached by an existing user's email), so there are no
pending invites to count. Enforcement is in the service layer
(`src/domain/organizations/membership-rules.ts`, used by both the org's own
settings and the admin section) under `SELECT … FOR UPDATE` on the organization
row, so simultaneous adds cannot overshoot (tested with a deterministic
lock-hold test plus a parallel-adds test). The same locked section protects the
last OWNER from being demoted/removed by two concurrent requests.
