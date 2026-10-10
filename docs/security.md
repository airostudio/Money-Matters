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

The admin's write set gained exactly one thing in the organisation-lifecycle slice: **archive / restore** an organization with a mandatory reason (section 17.3) - two
`UPDATE`s of three columns on the non-tenant `organizations` row plus the two audit rows. It does not widen the boundary: the shared archive rules are reached through the already
allow-listed `membership-rules` module, and the admin still reads no tenant data (a platform admin who is not a member of an archived company gets the same 404 as anyone else).

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
one active `organization_memberships` row. A pending invite code (section 17)
**holds no seat**: it is checked against the limit when it is redeemed, under the
same lock, so there is nothing else to count (a full company returns the specific
seat message and the invite stays valid). Enforcement is in the service layer
(`src/domain/organizations/membership-rules.ts`, used by both the org's own
settings and the admin section) under `SELECT … FOR UPDATE` on the organization
row, so simultaneous adds cannot overshoot (tested with a deterministic
lock-hold test plus a parallel-adds test). The same locked section protects the
last OWNER from being demoted/removed by two concurrent requests.

## 11. Period locks, month-end close, and the override/reopen workflow (Phase 9 Slice 3)

Locking and reopening a period change what the ledger will accept, so they are
treated as critical actions (master spec §41/§77). The model is in
`docs/accounting-engine.md` §15; this is the security view.

### 11.1 Who can do what

| Action | Permission | Roles |
|---|---|---|
| View the close checklist / workspace | `close_checklist:read` | OWNER, ADMINISTRATOR, ACCOUNTANT, BOOKKEEPER, MANAGER, READ_ONLY |
| Sign off (or revoke) a manual item | `close_checklist:manage` | OWNER, ADMINISTRATOR, ACCOUNTANT |
| Close a period / raise a lock | `period:close` | OWNER, ADMINISTRATOR, ACCOUNTANT |
| Post into a SOFT-locked period inline, with a reason | `period:override_soft` | OWNER, ADMINISTRATOR, ACCOUNTANT |
| Post into an ADVISOR-locked period | `period:post_advisor_locked` | OWNER, ADMINISTRATOR, ACCOUNTANT |
| Reopen / lower a SOFT or ADVISOR lock | `period:reopen` | OWNER, ADMINISTRATOR, ACCOUNTANT |
| Reopen / lower a **TAX or HARD** lock | `period:reopen_hard` | **OWNER, ADMINISTRATOR only** |
| Post into a TAX- or HARD-locked period | — | **nobody inline** (only the reopen workflow) |

A bookkeeper can see the checklist (it is how they learn what is outstanding)
but cannot sign off, close, override or reopen. The decision is made in the
pure function `evaluatePosting` / `evaluateLockChange` from the actor's
**server-side role**; the only client-supplied input is the free-text reason,
so there is no client-side bypass flag.

### 11.2 The audit trail is append-only at the database level

Every lock change and every posting made under an override is recorded **twice**:
in the org's `audit_logs` (`period.closed`, `period.locked`, `period.reopened`,
`period.lock_lowered`, `journal.posted_under_lock`, `close.signed_off`,
`close.signoff_revoked`) and in `period_lock_events` — who, when, why, before and
after level, and for TAX reopens the typed acknowledgement. `mm_app` is granted
**SELECT and INSERT only** on `period_lock_events` (no UPDATE/DELETE/TRUNCATE),
so the history cannot be rewritten even by a bug in the application; a test
connects as the real restricted role and shows each statement refused with
"permission denied". The close snapshot lives in `period_closes`
(SELECT/INSERT/UPDATE, no DELETE) and a reopen starts a new cycle rather than
editing the old one. Reopening lowers a lock; it never alters a posted journal
entry. All three tables are tenant-isolated (RLS enabled + FORCEd + policy),
with an isolation test for each.

### 11.3 AI has no write path

`FISCAL_PERIOD_CLOSE` is a permanently human-gated critical action at every
autonomy level: it is in the structurally-excluded list
(`EXCLUDED_ACTION_TYPE_EXAMPLES`), the auto-execution allowlist is a closed set
that contains nothing period-related, and no controller write tool touches a
period. On top of the role check, `assertHumanWith` refuses an actor whose type
is `AI` or `SYSTEM` for close, raise, reopen and sign-off **even when it carries
an OWNER role**, and `evaluatePosting` refuses such an actor any posting under a
lock. The only AI surface is the read-only `close_status` tool and the optional
"what remains" commentary (`docs/ai-agents.md` §0g); tests assert no tool name
or declared permission can close/lock/reopen/sign off.

### 11.4 Payroll sensitivity

The checklist's payroll item is measured only for an actor holding `payrun:read`;
for anyone else it is omitted (counted as hidden, excluded from the progress
figure, and the actor cannot close a period they cannot fully see) — the same
pattern as the cash forecast's payroll omission, and it carries through the AI
tool.

## 12. Multi-entity consolidation (Phase 9 Slice 4): RLS stays intact

A consolidated report needs figures from several organizations; tenant isolation
is one `app.current_org_id` per transaction. The tempting fixes — a multi-org
session variable, a bypass policy, a privileged connection, a SECURITY DEFINER
function — would each make one bug a cross-tenant leak. **None of them exists
here, and a structural test (`src/tests/unit/consolidation/boundary.test.ts`)
keeps it that way.**

### 12.1 Application-layer consolidation

`ConsolidationService` computes everything **in the application layer, one entity
at a time**:

1. one user-scoped transaction loads the group's own configuration;
2. one query loads the user's active memberships (their real role in every
   organization they belong to);
3. for each included entity, in order, strictly **sequentially** (a plain `for`
   loop; `Promise.all`/`allSettled`/`race`/`any` are structurally forbidden in the
   module, matching the connection discipline from the Supabase session-pooler
   incident — at most one pooled connection at a time), it builds an `Actor` from
   **that entity's membership role** and calls the existing report service, which
   runs inside that entity's own `withTenant(entityId)` transaction and itself
   enforces `financial_report:read` (cash: `bank_account:read` + `journal:read`);
4. the already-authorised results are aggregated in memory.

An entity the user has no active membership in is **never touched** (no
transaction is opened for it). A `PermissionDeniedError` from an entity excludes
it. The output carries "N entities excluded — no access": a count, plus the name
of an excluded entity **only when the user is still a member of it** (so the name
is already known to them); an entity they are not a member of is never named,
identified or described — not by id, slug, currency, or an unmatched intercompany
row. A platform admin has no special access: a group is reachable only by its
owner, and an organization only through a membership. Groups are capped at 10
entities (enforced on add and again on read). Tests instrument the dependencies
to prove one-at-a-time, only-reachable-entities, with the right role each time.

### 12.2 The group tables: user-scoped RLS (same strength, different key)

Group data spans organizations, so it cannot use the tenant policy. Rather than
leave it protected only by application checks, the eight group tables are
**user-scoped** with the same mechanism as tenant tables:

- `ENABLE` + `FORCE ROW LEVEL SECURITY` on every table (the owner role is not
  exempt either);
- one predicate everywhere: `owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid`,
  set per transaction by `withUserScope(userId, …)` (`src/db/user-scope.ts`) — the
  exact sibling of `withTenant`: **one user id per transaction, never a list**,
  and it does **not** set `app.current_org_id`, so inside a user scope no tenant
  table returns a row, and inside a tenant scope no group row does (tested both
  ways);
- the ownership key is denormalised onto every child table and enforced by
  composite foreign keys `(group_id, owner_user_id) → entity_groups(id, owner_user_id)`,
  so a child row can never carry a different owner than its group;
- an INSERT into `entity_group_members`, `_account_mappings` or
  `_intercompany_accounts` additionally requires, **in the policy itself**, that
  the owner is an *active member* of the organization named — so even an
  application bug cannot pull in an organization the user does not belong to
  (tested by inserting through `withUserScope` directly);
- the finer rule "adding an entity / mapping its account / designating it
  intercompany requires `consolidation:manage` **in that entity**" depends on the
  role→permission matrix, so it stays in the application layer
  (`assertPermission` with the entity `Actor`) — Owner, Administrator and
  Accountant hold it; READ_ONLY, Bookkeeper, Manager, … do not;
- grants are minimal: `entity_groups` has no DELETE (groups are **archived**);
  `entity_group_adjustments`, `_adjustment_lines` and `entity_group_audit_logs`
  are **append-only** (SELECT + INSERT; UPDATE/DELETE refused by Postgres itself —
  tested as the real `mm_app` role);
- group tables carry **no foreign key into any tenant table** (entity account ids
  are plain uuids resolved through the entity's own tenant transaction), and **no
  `organization_id` column** (it is `member_organization_id`) so they cannot be
  mistaken for tenant tables.

Why a user key and not a group key: a `group_id` policy would need a session
variable naming a group, which is a *capability* anyone who learns an id could set;
`owner_user_id` is the authenticated identity the application already resolves per
request, and the variable is exactly as narrow as the org one.

### 12.3 The isolation audit covers the new model

`npm run db:migrate` runs `src/db/isolation-audit.ts` (extracted from `migrate.ts`
so the rules are unit-tested). It classifies every table as organization-scoped
(`organization_id`) or user-scoped (`owner_user_id`) and requires, for each:
FORCEd RLS, at least one policy, and every policy expression keyed on **that
scope's variable and no other**. It also flags, on any table, a policy comparing a
session setting with `ANY(...)`, `string_to_array`, `unnest`, etc. (a multi-valued
scope). The user-scoped tables are therefore checked, not silently exempt; the
build log reports "67 organization-scoped and 8 user-scoped tables (of 82)".

### 12.4 Audit

Every group mutation writes `entity_group_audit_logs` in the same transaction,
including the user's real role in the entity where a permission was checked.
Adding or removing an entity also writes an informational note to **that entity's
own** audit log (`consolidation.entity_added_to_group` / `_removed_from_group`,
metadata: the opaque group id only) as a separate, sequential transaction after
the group commit, so an entity's owners can see their books are being
consolidated and by whom, without learning the group's name, its other members,
or any figure. (If that second write failed after the first committed, the group
log still holds the authoritative record.)

### 12.5 AI: no leak, by construction

The `consolidated_report` Controller tool (`docs/ai-agents.md` §0h) is a thin,
read-only wrapper over `ConsolidationService` with the user's real identity: same
per-entity checks, same exclusion notice, no id/organization argument (only a
report kind, a group **name**, and a date/period), no write counterpart, and
outside every auto-execution list. The summary text it hands the model is built
only from the already-authorised result, never names an excluded entity, and
carries the notice. A mandatory test with real restricted-role actors (EMPLOYEE in
one entity, no membership in another) captures every payload sent to the mocked
model and asserts no figure, name, slug or id of an unauthorised entity appears,
in the tool output or anywhere in the model's context or the answer path.


## 13. Accountant practices (Phase 9 Slice 5): practice scoping, consent, revocation

A practice (accounting firm) serves many client organizations and has several
staff. Its internal data (tasks, review notes, workpapers, assignments) belongs to
the **practice**, clients must not see it, yet staff must read client books. Tenant
isolation is one `app.current_org_id` per transaction, and the consolidation slice
added user-scoped tables on one `app.current_user_id`. This slice extends the same
model **without weakening RLS and without any bypass, privileged connection,
SECURITY DEFINER function or multi-valued predicate** (asserted by
`src/tests/unit/practice/boundary.test.ts`, which reads the migration).

### 13.1 Practice tables: one variable plus practice membership

Practice tables carry `practice_id` (and neither `organization_id` nor
`owner_user_id`). Their policy is a single-variable membership check:

```
EXISTS (SELECT 1 FROM practice_members pm
        WHERE pm.practice_id = <row>.practice_id
          AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND pm.status = 'ACTIVE')
```

set per transaction by `withUserScope(userId, …)`; FORCEd on every table. Because a
policy that queries its own table recurses in Postgres, the gate is built in layers:

- **`practice_partners`** — the ANCHOR: own-row policy only (`user_id = me`), no
  sub-select. A founder can insert themselves once (while they have no member row); a
  partner can promote another; **only the partner can delete their own row** (step
  down). Consequently a partner cannot be demoted or removed by someone else — the
  documented trade-off for keeping the policies recursion-free (a practice always
  keeps a partner).
- **`practice_members`** — the GATE (authoritative role/status): SELECT = my own row
  or any row of a practice I am a partner of (one sub-select, onto the trivial
  anchor); INSERT = the founder's first row or a partner adding someone; UPDATE = a
  partner, or a member leaving (WITH CHECK allows a non-partner to write only
  `status = 'REMOVED'` to their own row — no self-promotion).
- **`practice_roster`** — a read-only colleague directory any ACTIVE member may read
  (assignee lists, counting reviewers). Its role/status are not independent: a
  composite foreign key with `ON UPDATE CASCADE` onto `practice_members` keeps them
  equal.
- every other practice table asks only "is there an ACTIVE `practice_members` row for
  me in this practice?" (a sub-select onto the gate, whose own policy reaches only the
  trivial anchor — never itself).

A user outside the practice reads **zero rows** and every write is refused, in every
practice table, **even calling `withUserScope` directly** (tested table by table, plus
joining by writing one's own member/partner/roster row, self-promotion, and a removed
member losing access on the next statement). A removed member's access ends
immediately because the gate row's status changes.

Further database-level guarantees: `practice_audit_logs`, `workpaper_snapshots` and
`workpaper_signoffs` are **append-only** (SELECT + INSERT; UPDATE/DELETE refused by
Postgres — tested as the real `mm_app` role); a workpaper's schedule lines, evidence
and adjustments can be written **only while the workpaper is not SIGNED_OFF** (the
policy's `EXISTS (… w.status <> 'SIGNED_OFF')`), review-note **text** is immutable
(column-level UPDATE grant covers only the resolution columns) and a note is never
deleted.

### 13.2 The isolation audit

`src/db/isolation-audit.ts` classifies a table with a `practice_id` column (and no
`organization_id`/`owner_user_id`) as **practice-scoped**, plus the root `practices`.
For each it requires FORCEd RLS, a policy, every policy keyed on
`app.current_user_id`, none mentioning `app.current_org_id`, and — except for the two
gate tables and the root — every policy **consulting `practice_members`**. A table
whose policy lost the membership check (a bare user-variable predicate, or `true`) is
flagged in the build log and by `src/tests/unit/db/isolation-audit.test.ts`; the real
test database must pass with 18 practice tables. The three client-side tables
(`practice_client_consents`, `client_requests`, `client_request_messages`) carry
`organization_id` and are audited as ordinary tenant tables.

### 13.3 Reading a client's books: real membership + consent, one client at a time

The practice link grants **no** data access. Every read of a client:

1. loads the staff member's **actual membership role in that client** (the same
   `organization_memberships` row as any user; no membership → a specific error);
2. re-checks the client's **own consent record** (`practice_client_consents`, ACTIVE)
   in a fresh short `withTenant(clientId)` transaction **immediately before** the
   read — so revocation is effective on the very next read;
3. calls the client's existing service with an `Actor` carrying that real role, which
   applies the client's own RBAC (`close_checklist:read`, `bank_account:read`,
   `payrun:read`, `financial_report:read`, `journal:read` …).

A platform admin gets nothing extra (there is no admin branch). Practice modules open
no connection of their own, set no session variable, never call `Promise.all`, and
import no tenant table outside the two client-side services (all structurally tested).
**They cannot write a client's ledger**: no posting, journal, reversal or period-lock
service is imported — the single ledger import is the read-only
`LedgerService.getAccountBalance` (tested: journal entries/lines/trial balance/audit
ids of the client are byte-identical after a full workpaper lifecycle).

### 13.4 The handshake, revocation and retention

- The practice **proposes** by organization slug (partner or manager). The
  authoritative record is a row in the **client's own tenant**
  (`practice_client_consents`); the practice's `practice_client_links` row is a working
  copy. Only the client's OWNER/ADMINISTRATOR (`organization:manage`) can accept,
  decline, revoke, or re-approve; the practice can withdraw its own request or end an
  active link (partner). Each step writes the client's own audit log (real actor, opaque
  practice id) and the practice's append-only audit log.
- The proposal is the one write into a tenant by a non-member, so it is narrow: one
  PENDING row, a generic error (`ProposalNotPossibleError`) whatever the reason (unknown
  slug, queue full), at most 5 PENDING per organization, 100 links and 3 founded
  practices per user, and a declined link cannot be re-proposed by the practice.
- **Revocation is immediate** (step 2 above). The practice's working copy is brought
  up to date whenever it next verifies — each dashboard page load verifies that page's
  rows one at a time, and "Check status" does so on demand — at which point the link is
  marked, the event is audited and the retained dashboard snapshot is **blanked**
  (state `LINK_INACTIVE`, every figure NULL). The dashboard stops listing the client.
- **Retention (explicit):** the practice keeps its **own** records after a client leaves —
  tasks, review notes, sign-offs, evidence, and workpaper snapshots — because they are
  the firm's working papers. They are shown clearly "as of" the snapshot date with a
  banner that the client ended access; **no new client data can be read** (creating,
  refreshing or carrying forward a workpaper, requests, dashboard figures all refuse).
  A client who wants its data erased must raise that with the practice outside the
  product; the system does not delete a practice's records on revocation.

### 13.5 Client-visible vs practice-internal data

| Where | What | Who sees it |
|---|---|---|
| client tenant (`client_requests`, `client_request_messages`, `practice_client_consents`, the client's `audit_logs`) | queries, document requests, replies and attachments; the consent record; informational audit notes | the client's members by their own roles (`client_request:read`/`respond`, `organization:manage`, `audit:read`) |
| practice tables | tasks, deadline rules, review notes, workpapers, evidence, sign-offs, assignments, groups, snapshots, practice audit log | active practice members only |

The client's own audit log gets **only** an informational entry with the opaque
practice id and the acting user when a link is proposed/accepted/revoked/ended or staff
are assigned — never the practice name, other clients, assignee, tasks, notes or any
figure (tested). Practice-internal notes must never be put in a client request (the
UI says so); requests are in-app only (no email/notification infrastructure).

### 13.6 Seats

Staff who work on a client must be members of it, which uses one of that client's
seats (`organizations.seat_limit`, default 2). Nothing is bypassed or special-cased:
`addMemberByEmail` and `SeatLimitReachedError` are unchanged. When a staff member is not
a member the practice sees a **specific** message (`NotAClientMemberError`) naming the
client and its seat position — "… at its seat limit (2 of 2 seats used) … the platform
administrator must raise the limit … the limit is not bypassed" (tested end to end,
including the owner's add succeeding after the platform raises the limit). The client's
Accountant-access page shows its seat usage and where to add the person.

### 13.7 Connection discipline

Every `withTenant`/`withUserScope`/`db.transaction` checks out a pooled connection and
the Supabase session pooler caps the project at roughly 15, so the dashboard never
fans out: it reads materialised `client_health_snapshots` (counts only) in one
user-scoped transaction of set-based queries; **Refresh** runs one client at a time (a
tenant consent check, then the checklist's own sequential reads, then a user-scoped
upsert), per client or per page of at most 10; the page verifies at most its own
10 rows' consent one after another. Caps: 10 clients per page and per bulk action, 100
links, 25 staff. Tests instrument both wrappers and assert at most one scoped
transaction is open at any time and exactly which organizations were opened.

### 13.8 Who sees which figure

A snapshot refreshed by a colleague with more permissions must not widen what you
see: each dashboard indicator is gated by **the viewer's own role in that client**
(payroll "not visible to your role" without `payrun:read`; likewise books and
reconciliation), and a client appears only if the viewer is a member of it. A
refresh by a role lacking a permission stores NULL ("not measured"), never zero.

### 13.9 AI no-leak

`practice_overview` and `workpaper_status` (read-only Financial Controller tools) take
no organization, client or account id. They read saved snapshots and the practice's own
records, include a client only if the user holds a real membership with the needed
permissions **and** the link is ACTIVE, and report every other client only as a count
("N … excluded"). Tests with real restricted-role actors and a mocked model prove that
no unauthorised, pending, revoked or foreign client's name, id, slug or figure reaches
the tool output or any payload sent to the model, that payroll respects `payrun:read`,
that a write attempt is an unknown tool, and that the auto-execution policy and the
human-only period-close rule are unchanged. See `docs/ai-agents.md`.

### 13.10 Audit

Every practice mutation writes `practice_audit_logs` in the same transaction (a
failed audit rolls the change back); the client's tenant mutations (consent changes,
requests) write the client's own audit log with the real actor. Workpaper sign-offs and
reopenings are additionally in the append-only `workpaper_signoffs` history with
identity, role, version, reason and the single-staff-exception flag.

## 13a. BAS / GST preparation (Phase 8 Slice 2): human-only finalising, immutable snapshots

- **Permissions.** `bas:read` (OWNER, ADMINISTRATOR, ACCOUNTANT, BOOKKEEPER), `bas:manage` (same; prepare / discard drafts), `bas:finalise` (OWNER, ADMINISTRATOR, ACCOUNTANT). MANAGER and READ_ONLY deliberately do **not** hold `bas:read` because the BAS shows payroll totals (W1/W2), which need `payrun:read`-level trust.
- **Human-only.** `finalise` and `markLodgedOutside` refuse any actor that is not `HUMAN` (AI, API key, automation, system), even an OWNER-role one (tested). The AI Controller has one read-only tool, `bas_summary` (`bas:read`); there is no AI write path to a BAS.
- **Immutability is a database property.** `bas_statements` has per-command RLS policies: UPDATE and DELETE only match rows whose `status = 'DRAFT'`, so a finalised snapshot cannot be edited or deleted by `mm_app` whatever the application does (verified as the real role). `bas_lodgement_records` is append-only (`SELECT, INSERT` grants). Both are FORCE-RLS tenant tables covered by the isolation audit and the tenant-isolation test.
- **Nothing leaves the system.** No ATO endpoint, credential or transmission exists. "Lodged outside Money Matters" is an unverified note. Every page, CSV and AI answer carries "requires registered tax agent / BAS agent review; NOT lodged with the ATO".
- **Audit.** `bas.draft_created`, `bas.draft_deleted`, `bas.finalised` (labels + hash), `bas.lodgement_recorded`, `tax_code.bas_classification_changed`.

## 13b. Payroll operations (Phase 8 Slice 3): payslips, payments, leave

- **Payslips are own-record only.** `payslip:read` is held by every role (including READ_ONLY), but `PayslipService` returns a payslip only when the pay run line belongs to the employee record whose `user_id` is the caller's login; holders of `employee:manage` (payroll managers, owners, administrators) read anyone's. Any other request is "not found", never "forbidden", so existence does not leak. Human-only (AI, API and automation actors are refused). No TFN on a payslip; the bank account is masked to its last four digits.
- **Payments.** `payroll_payment:read` (ACCOUNTANT, BOOKKEEPER, PAYROLL_MANAGER) and `payroll_payment:manage` (ACCOUNTANT, PAYROLL_MANAGER, OWNER, ADMINISTRATOR) plus `journal:post`/`journal:reverse` at the ledger. Recording, reversing and generating the ABA file are human-only. `payroll_payments` is a tenant FORCE-RLS table with `SELECT, INSERT` and column-level `UPDATE` of only the status/reversal columns for `mm_app`: an amount cannot be edited and a row cannot be deleted (tested as the real role).
- **ABA file.** Needs `payroll_payment:manage` AND `employee:manage` (it reads full BSB / account numbers). The originator's bank identifiers are form fields, never stored and never logged; the audit row holds only counts and totals (tested: no BSB or account number reaches `audit_logs`). The download route is POST-only with `Cache-Control: no-store`.
- **Leave.** `leave:request` (every role except READ_ONLY), `leave:read` and `leave:approve` (MANAGER, PAYROLL_MANAGER, OWNER, ADMINISTRATOR; ACCOUNTANT reads only). Nobody can approve or reject their own request (by requester id or by linked employee record). `leave_requests` has no DELETE grant.
- **Reversal.** `payrun:reverse` (ACCOUNTANT, PAYROLL_MANAGER, OWNER, ADMINISTRATOR) with a mandatory reason; audited (`pay_run.reversed`).
- **Autonomy.** Payroll remains structurally excluded from AI auto-execution; no payroll tool was added to the AI Controller.

## 14. Sharing a company file (read-only colleagues and concurrent sessions)

**Adding a read-only colleague.** An Owner or Administrator opens **Settings -> Team ->
Add a teammate**, types the email of someone who has **already registered** (there is no
email sending and no pending-invite concept yet), and picks a role. The picker starts on
**Read only**, lists roles from least to most privileged, and describes the selected role
in plain language - what it can change and what it can only view - derived from the real
permission matrix (`src/domain/permissions/role-info.ts`), so the text cannot drift from
what the role can actually do. Granting any role that can change financial data (every
role except Read only; Owner and Administrator included) requires the explicit
confirmation "I understand this person will be able to edit financial data". That rule is
**enforced in `OrganizationService.addMemberByEmail` / `updateMemberRole`**, not just by the
checkbox: the settings actions always pass `{ confirmWriteAccess }`, and a missing
confirmation is refused with `WriteAccessConfirmationRequiredError` (no seat is used,
nothing is changed). Callers that pass no options at all are trusted server-side code
(seed scripts, test fixtures, practice staff); nothing reachable from a browser does.
Role changes and removals are audited as before (`membership.role_changed`, ...).

**Two people at the same time.** Sessions are JWTs, so any two members can be signed in
at once. Every request re-checks the user and membership, and permission checks happen in
the domain services on every call.

**What each role can do** - see the table in `roles.ts`; in short: Read only sees
everything the books show and changes nothing; Employee submits own expenses/timesheets;
Manager approves expenses/timesheets and manages projects; Accounts receivable / payable
work the sales / purchases side; Payroll manager runs payroll; Bookkeeper does day-to-day
bookkeeping; Accountant adds period close, voids and consolidation; Administrator and
Owner can do everything including people and settings (there is always at least one
Owner).

**What a read-only member experiences.** A banner in the shell says they have read-only
access and to ask the company owner for more; the nav shows only what they may read;
"New ..." buttons, edit/post/void/approve actions and the settings forms are hidden
(`Can`, `deniedViewUnless`, `createActionsFor`). "Read-only" is derived by
`isReadOnlyRole(role)` - true when the role holds no permission other than `*:read` - not
by comparing against the string `READ_ONLY`. A write page opened directly (a bookmark, a
stale tab) shows a friendly "you can't make changes here" view naming the area and the
role. Every org server action ends in a catch-all (`rethrowPermissionDenied`,
`src/lib/action-errors.ts`) that turns a `PermissionDeniedError` from a stale tab or a
crafted request into a redirect to `/<org>/access-denied`, a friendly page naming the area
and the viewer's real role (HTTP 200, nothing written). A refusal thrown while *rendering*
a page (a role opening a page it has no read permission for by typing the URL) reaches the
org-level `error.tsx`, which recognises `PermissionDeniedError` through its `digest`
(Next.js hides the message in production but keeps a digest the error carries) and shows
the same explanation instead of "Application error"; that path is rendered by the browser
after hydration and the HTTP status of such a response is still 500.

**Hiding is presentation only.** Every hidden action is still refused by the domain
service (`assertPermission`); `src/tests/integration/organizations/shared-access.test.ts`
proves a READ_ONLY member is refused for invoice create/update/delete/post, bill
create/update/post, manual journal post, member add/remove/role change, AI-autonomy
(organization) settings and account creation, while reading invoices, accounts, the
ledger and reports works. No RLS policy, seat-limit rule or the platform-admin boundary
changed.

**Two writers at once.** Two people who can both write (say an Owner and an Accountant)
could otherwise overwrite each other. Draft **invoice** and draft **bill** edit forms carry
a hidden `expectedVersion` (the record's `updatedAt`). `InvoiceService.update` /
`BillService.update` lock the row (`SELECT ... FOR UPDATE`), compare, and refuse a stale
save with `StaleEditError` ("This invoice was changed by <name> at <time> since you
opened it ... reload"), changing nothing. A form with no/garbled version is treated as
stale; programmatic callers that omit the field are unaffected. **Limits:** only draft
invoices and bills are covered. Posted documents are already immutable; quotes,
contacts, projects, budgets, journals drafts, settings, etc. are still last-write-wins.

**Seat limit.** Each company file defaults to **2 seats** (the owner plus one colleague);
a read-only member occupies a seat like any other. When it is full, the Team card says so
and removing someone frees a seat. More seats are raised by the **platform
administrator** from `/admin/organizations/<id>` (see 10.6) - the owner cannot raise it
themselves. Colleagues can also be brought in with a single-use **invite code** (section 17), which
checks the seat limit at redemption and uses the same "writer role needs explicit confirmation" rule at creation.

## 15. Public developer API (Phase 10 Slice 1): API keys, effective permissions, the lookup index

An API key is a **new authentication path into tenant data** that bypasses the browser session and the app shell. Everything
the rest of this document guarantees has to hold on it. Developer-facing description: `docs/api.md`.

### 15.1 The key and its secret

- Format `mm_live_<prefix>_<secret>`. The 8-character **prefix** (`[a-z0-9]`) is not secret: it is displayed in the key list, named
  in audit rows and used to find the key with one indexed query. The **secret** is 32 bytes (256 bits) from the OS CSPRNG, as 43
  base64url characters.
- Shown to the creator **exactly once**, in the response to the create action (`useFormState`), held only in that form's client state.
  Never in a URL, redirect, cookie, log, audit row or database.
- Stored only as a **SHA-256 hex digest of the whole key**. A slow password hash (bcrypt/scrypt) is deliberately *not* used: those
  exist to make guessing a *low-entropy* secret expensive; here the secret is 256 bits of uniform randomness, so there is nothing to
  guess or run a dictionary against — brute force is infeasible at any hash speed — and a slow hash would only make every
  request slower and give an attacker a pre-authentication CPU-exhaustion lever. Comparison is constant-time
  (`timingSafeEqual` on equal-length buffers).
- Never returned by any list/get (the list selects explicit columns; a structural test asserts the query never mentions the hash),
  never in audit `before`/`after` (`secretHash`, `secret_hash`, `apiKey`, `api_key`, `authorization` were added to
  `AuditService`'s `REDACTED_FIELDS`, on top of the audit rows simply never containing it), never logged (the API logs only the
  request id, route and the first line of an unexpected error; a structural test forbids logging headers, bodies or keys).
- Accepted **only** via `Authorization: Bearer <key>`. Not the query string (a URL ends up in logs, referrers and history), not a cookie.

### 15.2 Effective permissions = key scopes ∩ the creator's CURRENT role ∩ the API whitelist

Computed on **every request**, never stored:

1. The key's scopes (a closed set of ten, `src/domain/api/scopes.ts`) map to **existing** permissions — there is no parallel
   permission system. `*:write` is draft-creation only.
2. The result is intersected with the permissions the key creator's **current** role holds, read in the same query that finds
   the key. Demoting the creator shrinks the key on the next request; removing them (`organization_memberships.is_active`) or
   suspending them (`users.disabled_at`, the same flag the session layer checks) kills it (`401 api_key_owner_inactive`), and
   reinstating them revives it. A key can never do more than its creator could, and never more than its scopes.
3. The result is intersected with `API_ALLOWED_PERMISSIONS`, an explicit whitelist of eleven permissions (contact, account,
   customer-invoice and supplier-bill read/manage-as-draft, customer/supplier payment read, journal read, financial report read). A test pins
   the exact contents so adding to it is a deliberate, reviewed change.

The result becomes the `Actor` the domain services receive: `type: "API"`, `role` = the creator's current role, and
`grantedPermissions` = the effective set. `assertPermission` consults `grantedPermissions` **in addition to** the role check, so
services enforce permissions for an API caller exactly as they do for a human, and the extra field can only ever remove power.

### 15.3 Human-only and critical actions are unreachable — structurally

- `ActorType` gained `"API"` (and the `audit_actor_type` enum the value `API`). Every human-only check in the codebase asks "is this
  actor a HUMAN?" (`assertHumanWith` for period close/reopen/sign-offs, `evaluatePosting` / `evaluateLockChange` for overrides), so an
  API actor is refused **even with the OWNER role and a granted permission** — a test runs those checks with an API owner.
- No scope maps to a human-only or critical permission, and `API_ALLOWED_PERMISSIONS` excludes them: period close/reopen/lock overrides and
  sign-offs, member/role/seat management (`membership:manage`), AI autonomy settings (`organization:manage`), payment-run
  approval, payroll (`payrun:*`, `employee:*` — v1 has no payroll or employee endpoint), practice and consolidation, platform admin,
  `*:post|void|approve|reverse` and `api_key:manage`. `isForbiddenForApi` classifies every permission by action and resource and a test
  walks the whole `PERMISSIONS` list; another test asserts the union of everything any scope can grant equals the whitelist.
- `api_key:manage` exists only on OWNER and ADMINISTRATOR (they hold every permission), and `ApiKeyService` additionally requires a
  `HUMAN` actor: an AI, system or API actor is refused. No AI controller tool, specialist mode or auto-execution entry mentions
  keys (`src/tests/unit/api/ai-boundary.test.ts`), and a test pins the only modules that import the key service.
- **Writes are draft-only.** The only write endpoints create customers/suppliers and DRAFT invoices/bills through
  `ContactService.createIn`, `InvoiceService.createIn`, `BillService.createIn` (the existing creation code, now callable inside a
  caller-owned transaction), so validation, tax calculation, permission checks and audit are the human path's. There is no
  post/approve/void/pay/delete route and no `PUT`/`PATCH`/`DELETE` method (middleware answers `405`).
- A draft dated in a **locked period** is refused for every lock level (`evaluatePosting` with actor type `API`, which only allows
  OPEN): an integration has no override. Stricter than the UI by design; nothing is persisted.

### 15.4 The key-lookup index and why it does not weaken tenant isolation

Authentication must find a key **before** it knows the organization (the key identifies it), so it cannot run under
`withTenant`. The design:

- **`api_keys`** — the management record (name, prefix, scopes, creator, expiry, revocation). An ordinary tenant table: RLS enabled and
  FORCEd, the usual single-variable `app.current_org_id` policy, `mm_app` granted `SELECT, INSERT` plus `UPDATE (revoked_at,
  revoked_by_user_id)` only — no `DELETE`, no editing a key's scopes or name. It never holds the secret or its hash.
- **`api_key_index`** — a narrow, non-tenant projection used only by authentication: `prefix → organization, key id, secret hash,
  creator, scopes, expiry, revocation, rate limit, last used`. It holds **no financial or personal data**, only authentication
  facts, and it is the **only** RLS-exempt table added (next to `organization_memberships`, `src/db/isolation-audit.ts`
  `RLS_EXEMPT_TABLES`). Its exposure is bounded by grants, not policies: `mm_app` has `SELECT, INSERT` and `UPDATE (revoked_at,
  last_used_at)` — **no `DELETE`/`TRUNCATE`, and the hash, prefix, organization, creator, scopes, expiry and limit can never be
  rewritten**. A composite foreign key `(id, organization_id) → api_keys(id, organization_id)` means an index row for a key that
  does not exist in that organization cannot be inserted — and creating the `api_keys` row for another organization is blocked by its RLS
  `WITH CHECK` — so a transaction scoped to organization A cannot mint a working key for organization B.
  `src/tests/integration/api/api-isolation.test.ts` proves each of these as the real restricted role.
- Reading it does not reach tenant data: what it returns is the organization **id** and a SHA-256 of a 256-bit secret. Seeing the hash
  of someone's key does not let you present the key. Its trust level is the same as `organization_memberships`, which is already
  readable and writable by the application without a tenant context.
- After the lookup, **everything runs in one `withTenant(<the key's organization>)`** as `mm_app`. No RLS policy was changed, no
  bypass, no privileged connection: a cross-organization id is a `404` (tested for every endpoint), and lists never show another
  organization's rows. Cursors are HMAC-signed and bound to organization, endpoint and filters, so a tampered or transplanted cursor
  is `400` — and even a forged one could only address the caller's own rows, because RLS still applies.
- `api_rate_windows` (one counter row per key, `SELECT, INSERT, UPDATE` only) has no organization column and holds only counters.

### 15.5 Rate limiting, abuse protection and the per-instance caveat

- **Per key, in Postgres, no Redis:** `api_rate_windows` holds one row per key; one atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` per request advances a fixed 60-second window using the *database* clock (so every app
  instance agrees). Default 60 requests/minute, per-key override 10–600 (clamped). `429` carries `Retry-After`; every response carries
  `X-RateLimit-Limit/Remaining/Reset`. The same statement stamps `last_used_at` at most once a minute, so reads do not become writes.
  A fixed window permits a burst of up to 2× across a boundary — accepted for a single-statement counter; it protects the database from
  a runaway integration, it is not a billing meter.
- **A wrong secret never consumes the real key's quota** (the counter is only touched after the hash verifies), so an attacker who
  knows a prefix cannot lock the owner out by spraying bad secrets.
- **Invalid keys cannot hammer the database:** a malformed `Authorization` value is rejected with no query; an unknown prefix costs one
  query. On top, a small **per-IP, in-memory** throttle cuts off an address after 20 failures in a minute (`429`), before any query.
  It is per server instance, resets on a cold start and trusts a proxy header, so it is **not** a security boundary — the boundary is
  the 256-bit secret — but it stops the realistic cases (a misconfigured retry loop, a naive scanner) on the instance receiving
  them, which is where the database cost would otherwise land. Failures are the only thing counted and a success clears the address.

### 15.6 No cookies, no CORS, no session

`src/middleware.ts` lets `/api/v1/*` through **without** the NextAuth redirect and **removes the `Cookie` header** from the request the
route sees, so a browser session cookie has nothing to ride on (CSRF cannot reach the API) and the route handlers neither read nor set
cookies. No `Access-Control-*` header is ever sent and `OPTIONS` is refused, so browser use is unsupported by design; keys belong on
servers. Responses are `Cache-Control: no-store`. The organization slug `api` stays reserved. Structural tests assert the API modules
import no session/cookie code and contain no CORS headers.

### 15.7 Auditing

Every API-originated write is audited by the same domain services as a human's, in the same transaction. `AuditService.record` adds,
for an `API` actor, `metadata = { viaApiKey: true, apiKeyId, apiKeyPrefix, apiKeyCreatedBy }` to **every** row the request writes
(including rows services write on their own), and `actor_type = 'API'` with the creator's user id. Key creation and revocation are
audited (`api_key.created`, `api_key.revoked`) with id, prefix, name and scopes — never the secret or its hash.

### 15.8 What is not covered

OAuth 2.0 for third-party apps (the auth layer is credential-agnostic by design); per-key IP allow-lists; a distributed (cross-instance)
failure throttle; automatic rotation. Webhooks arrived in Slice 2 (section 16); the integration framework is the next slice.

## 16. Webhooks (Phase 10 Slice 2): SSRF guard, signing secrets, signatures, human-only management

Webhooks make the **server** issue HTTP requests to a URL a customer chose: a textbook SSRF primitive, plus a new store of secrets that must be recoverable.
Developer-facing description: `docs/api.md` "Webhooks". Pipeline design: `docs/architecture.md` §12.

### 16.1 The outbound guard (one guard, every request)

One code path (`src/domain/webhooks/url-guard.ts`, `ip-classifier.ts`, `outbound.ts`) validates a subscription URL **when it is saved** and again on **every delivery**
(a stored row is not trusted: a tampered or stale URL is refused at send time with no lookup and no request).

- **URL rules.** `https` only (no `http`, `file`, `javascript`, ...); **no credentials** in the URL; **port 443 only**; no fragment; <= 2048 characters; no whitespace or control
  characters; no `localhost`/`.local`/`.internal`/`.lan`-style names and no single-label hosts. An **IP-literal host** is classified directly: private/special literals are refused, and
  because the WHATWG URL parser canonicalises decimal/hex/octal/short spellings (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) to dotted decimal before the guard sees them, those
  forms are caught too (tested).
- **Resolution.** The host name is resolved and **every** returned address must be publicly routable; one private address among public ones refuses the whole host (a hostile DNS
  server can interleave them). The classifier is **default-deny**: it allows only global unicast. It refuses `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16`
  (link-local **including the cloud metadata address 169.254.169.254**), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`,
  `224/4`, `240/4`; and for IPv6 `::`, `::1`, `::/8` (incl. the deprecated IPv4-compatible form), `fc00::/7` (ULA), `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001::/23` (Teredo and IETF
  assignments), `2001:db8::/32`, `3fff::/20`, `100::/64`, `5f00::/16`, everything outside `2000::/3`, and the **IPv4-embedded forms** - IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated,
  NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) - judged by the embedded IPv4 (so `::ffff:169.254.169.254` is refused and `::ffff:8.8.8.8` is not). The exhaustive table is
  `src/tests/unit/webhooks/ip-classifier.test.ts` (119 cases: both edges and the middle of each refused range, the boundary just outside each, public addresses, malformed text).
- **DNS rebinding (the check/connect TOCTOU).** The delivery resolves the host **once**, vets all answers, and the socket is then opened **to that vetted address** through a pinned `lookup`
  (the resolver's answer is never consulted again, so DNS cannot be re-pointed at an internal address between the check and the connect). The pinned lookup re-classifies the address at the
  instant the socket asks for it. TLS still runs against the **real host name**: SNI and the certificate hostname check use the name, not the IP. A test against a real local TLS server
  whose host name does not exist in DNS proves the connection goes to the vetted address with the right SNI/`Host`, and that a valid certificate for a *different* name is refused.
- **TLS verification is never disabled** (`rejectUnauthorized: true`, TLS >= 1.2; a structural test forbids `rejectUnauthorized: false`, `checkServerIdentity` overrides and the env override).
- **Redirects are never followed.** A 3xx is a recorded failure (`redirect`); a redirect to `http://169.254.169.254/...` is therefore never requested (tested: exactly one request reaches the server).
- **Bounds.** 10 s connect-plus-total timeout; the response body is read for at most 8 KB and the connection dropped (a 50 MB response returns promptly); request body <= 512 KB (events are capped at 256 KB at
  emit); the stored excerpt is <= 1000 characters, decoded as UTF-8, with every control/bidi/line-separator character replaced by a space (rendered as plain text, never HTML).
- **Limits of this guard (defence in depth, not the only wall).** It runs in application code on the serverless platform: outbound requests originate from the platform's network, not a
  fixed egress IP, so there is nothing for a customer to allow-list and the platform's own egress policy remains the outer control. The guard cannot see addresses the operating system
  resolver would return differently on another host, cannot stop an *attacker-controlled public* endpoint from receiving the (signed, DTO-only) payload - that is the feature - and does not
  defend against a compromise of the platform's DNS or kernel. It does not follow CNAME chains itself: the resolver's final addresses are what is vetted.

### 16.2 Signing secrets: encrypted at rest, shown once

Signing needs the raw secret, so unlike an API key it cannot be a one-way hash. Each subscription's secret (`whsec_` + 256 bits from the CSPRNG) is encrypted with **AES-256-GCM** under a key that
exists **only in the environment** (`WEBHOOK_SECRET_ENCRYPTION_KEY`: 32 random bytes, base64 - `openssl rand -base64 32`; never in the database), with a fresh random 96-bit IV per encryption. The stored
value is `base64(version byte | IV | auth tag | ciphertext)` with the **key version** also in its own column. The GCM additional authenticated data binds the ciphertext to its
`(organization, subscription)` pair, so a ciphertext copied into another row, or any tampered byte, fails authentication (tested for tamper, wrong key, wrong row, truncation).
A database dump alone therefore yields no usable secret; an attacker needs the dump **and** the environment.

- **Shown once** in the response to the create/rotate action (`useFormState`), never in a URL, cookie, log, redirect or audit row; never returned by any list. `AuditService`'s redaction list gained
  `secretCiphertext`, `previousSecretCiphertext`, `signingSecret` (belt and braces: the services never pass them), and tests search the whole `audit_logs` table for the secret and its ciphertext.
  A structural test forbids any `console` call in the webhook modules.
- **Fail closed.** With the variable missing or invalid, `loadKeyring` returns a reason (never throws): subscription creation, rotation, replay, test events and dispatch refuse with "Webhooks are
  disabled: ...", Settings shows the message, events keep accumulating safely in the outbox, and **nothing else is affected** - the build does not read the variable (it is reported only as an
  optional-feature note by `npm run db:migrate`, never as a failure).
- **Key rotation.** The keyring holds the current key (`WEBHOOK_SECRET_ENCRYPTION_KEY`, version from `WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION`, default 1) and any older ones as
  `WEBHOOK_SECRET_ENCRYPTION_KEY_V<n>`. New ciphertexts use the current version; old ones still decrypt via the version byte; a ciphertext whose key was dropped fails loudly. There is no bulk
  re-encryption job in this slice: a subscription's ciphertext moves to the new key the next time its secret is rotated. Losing the key makes every stored secret undecryptable (rotate each
  subscription to recover) - back it up like any production secret.
- **Secret rotation with overlap.** Rotating issues a new secret and keeps the previous one for **24 hours**: during the window every delivery carries two signatures (`v1=<new>,v1=<old>`) so a
  consumer can deploy the new secret without downtime; after it, only the new one is used (tested both sides of the boundary). Rotating again inside the window replaces the old secret at once.

### 16.3 The signature

`Mm-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`; also `Mm-Event-Id`, `Mm-Delivery-Id`, `Mm-Event-Type`, `Mm-Subscription-Id`, `Mm-Delivery-Attempt` and
`User-Agent: MoneyMatters-Webhooks/1`. The timestamp is inside the signed message so a captured delivery cannot be re-sent later with a fresh timestamp, and consumers are told to reject deliveries more than
**5 minutes** from their clock (replay protection) and to compare in constant time. The published Node.js and Python verifiers are executed against the real signer in the test suite, and the docs are
asserted to contain them verbatim.

### 16.4 Human-only management; unreachable from the API and the AI

`webhook:manage` is held by OWNER and ADMINISTRATOR only and `WebhookSubscriptionService` additionally requires a **HUMAN** actor - an API-key, AI or SYSTEM actor is refused even with the OWNER role. It is
unreachable from the API by construction (`webhook` is a forbidden resource in `isForbiddenForApi`, absent from the scope whitelist, and no `/api/v1` route mentions webhooks) and from the AI (no tool, specialist
mode or auto-execution entry; a test pins the only modules that import the webhook services). Creating a webhook is a decision to aim the platform at a URL, so it stays with a person. Every mutation is audited
(`webhook_subscription.created|updated|paused|resumed|re_enabled|secret_rotated|deleted|test_sent|auto_disabled`, `webhook_delivery.replayed`) in the same transaction. The per-organization cap (10) is enforced under an advisory lock so
concurrent creates cannot exceed it.

### 16.5 Data exposure and tenancy

- **Payloads are the public API's DTOs and nothing more**, built by the same mappers and loaders, validated in tests against the API's strict response schemas (any extra field fails). No internal ids or columns, money as
  decimal strings with a currency. The envelope carries no organization id; the opaque `Mm-Subscription-Id` header identifies the registration.
- Four new tenant tables - `domain_events`, `webhook_subscriptions`, `webhook_deliveries`, `webhook_delivery_attempts` - each with RLS enabled + FORCEd and the single-variable policy; the build-time isolation audit
  passes (76 tenant tables), and tests verify visibility, cross-tenant WITH CHECK refusal and the grants over a raw connection as the real `mm_app` role.
- **The attempt log is append-only**: `mm_app` has `INSERT, SELECT` only on `webhook_delivery_attempts` (UPDATE, DELETE and TRUNCATE are denied - tested). `domain_events` is `SELECT, INSERT`, `UPDATE (dispatched_at)` and `DELETE` (retention):
  a recorded event's type, aggregate and payload cannot be rewritten. Honest note: because `domain_events` rows may be DELETEd for retention and attempts cascade from them via the foreign key (an action performed by the table owner, not by
  `mm_app`), the application role *could* erase recent log rows by deleting their event; the grants stop edits and direct deletes, not a compromised application that deletes events. Retention is the only code path that does so, and it
  only touches events older than 30 days.
- Response excerpts are untrusted text from the customer's server: truncated, control-stripped, length-capped on write, rendered as text.

### 16.6 What is not covered

mTLS or an allow-listed sender IP (no stable egress); a global dispatcher; per-event payload customisation; wildcard subscriptions; email alerts for dead letters; bulk re-encryption on key rotation; `payroll.completed` and
`bank.transaction.created` (their data has no API representation and so no agreed permission rule for exposing it).

## 17. Organisation lifecycle & joining (archive, create another company, invite codes)

Built: reversible **archive**; **create another company** under the same login; **join a company with an invite code**. Deliberately **not** built: permanent deletion, email-delivered invites,
request-to-join (reasons in §17.8 and `docs/roadmap.md`). Schema: `docs/database.md` §2t. Manual-deletion runbook (DBA only, outside the app): `docs/operations.md`.

### 17.1 What "archived" means

`organizations.archived_at / archived_by_user_id / archive_reason`. **Archive is not deletion**: those three columns are the whole change - no tenant row, membership, seat, API key, webhook
subscription, autonomy setting or audit row is touched, and the slug stays reserved (the unique index covers archived rows). Restore clears the three columns and the company is exactly as it was
(`archive.test.ts` snapshots ledger, trial balance, journal rows, memberships, API keys, webhook subscriptions, the organization row and every pre-existing audit id before and after, byte for byte,
and the previously issued API key works again). While archived **nobody** - member, owner, administrator or API key - can read or write the company's data through any application path.
Seats and memberships are untouched, so a restored company has the same team; a **practice** link to the company simply stops resolving (below) and resumes on restore; consolidation groups keep the
entity configured and resume including it.

Because the check must not add a query to `withTenant` (the hot path - DB connection discipline), it lives at the **few places where a person, key or process is turned into an Actor for an
organization**. That is a short, finite list, and `src/tests/unit/organizations/archived-entry-points.test.ts` reads the source and fails if a new one appears (or an existing one changes
shape) until it is added to the audited table with a statement of how it refuses an archived organization.

### 17.2 The entry points (all refuse an archived organization)

| Entry point | How it refuses | Extra queries |
|---|---|---|
| `OrganizationService.getMembership` (the basis of every session helper, practice, route handlers) | returns `null` for an archived organization unless the caller passes `includeArchived` (only the restore path and the layout do) | none: the `organizations` join that carries the flag replaced a single-table read |
| `requireOrgAndActor` / `requireActor` (every server action and page) | a **member** gets `OrganizationArchivedError` (carries a digest the org `error.tsx` renders as "This company is archived"); a non-member gets `NotAMemberError`, as before | none (`getMembershipWithState` is the same one query) |
| `getActorForOrganization` (route handlers, e.g. request attachments) | `null` -> 404 | none |
| `[orgSlug]/layout.tsx` (every page) | members see the **archived page** (Restore button for OWNERs; "ask an owner" for others) and `children` is never rendered (Next still starts the page segment concurrently - the real-HTTP smoke test's server log shows it - but that page's own `requireOrgAndActor` throws `OrganizationArchivedError` before any read, so the only effect is a logged error, never data); non-members get a plain 404. *Why not 404 for everyone:* a member already knows the company exists, a 404 would read as data loss, and a non-member learns nothing either way | none (the layout's three reads became two for an archived company) |
| Company chooser `/app` | archived companies are split into an "Archived companies" list (Restore for OWNERs only) and never take part in the "exactly one company -> redirect" decision, so a person whose only company is archived lands on the chooser, not a loop | none (**one** membership query feeds the list, the redirect, the owned-company count for the create cap) |
| Company switcher | built from `listMembershipsForUser`, which excludes archived | none |
| **Public API** (`api-auth.ts`) | the one lookup join now also joins `organizations`; a valid key of an archived company gets `403 organization_archived` (problem JSON) *after* its secret verified (a wrong secret still gets `invalid_api_key`, so the archive is not disclosed) | **none**: still 2 statements for an active key (lookup + rate-limit upsert); an archived key costs **1** (the lookup) and never reaches the rate limiter or a tenant transaction - measured in `archive.test.ts` |
| **Webhook dispatch** (`dispatch-service.ts`, also the post-response run and "Send now") | the archived flag is read in the **same statement** as the existing fan-out try-lock; an archived organization returns before fan-out, claim or send. Events stay in the outbox (`dispatched_at` NULL) and flow, in order, after a restore | none (same statement; test asserts the statement count does not grow) |
| **AI auto-execution** (`isAutoExecutionApproved`) | level and archived flag are read together; an archived organization is never approved (`skippedReason: "organization is archived"`). Level and whitelist are left untouched so a restore resumes exactly the same configuration | none |
| **Recurring "generate due"** (`RecurringInvoiceService/RecurringBillService.generateDue`) | the template read excludes an archived organization (`NOT EXISTS ...`), so it returns `[]` | none (inside the existing read) |
| **Practice** (client-access map, `requireClientActor`, `HealthService`) | they read memberships through the archive-aware helpers, so an archived client drops out of dashboards (counted only in "not accessible"), refresh answers a neutral "<client> is currently unavailable" - no seat, member or archive detail - and `propose` treats an archived slug as unknown | none (the failure path's existing seat lookup also reads the flag) |
| **Consolidation** (`loadEntityAccessMap`) | an archived entity is absent from the access map, so it is excluded from every report with the existing "N entity excluded - no access" notice and no name, id, slug or figure | none |
| Daily brief, AI chat, reports, everything else | ride on the session helpers above | none |

`src/app`, `src/lib` and `src/components` never import `withTenant`, `withUserScope` or the raw `db` handle (asserted), so the request layer cannot bypass the helpers.

### 17.3 Who can archive and restore

- **OWNER, human only** (`OrganizationLifecycleService.archive`): Settings -> Danger zone. Needs the company name typed **exactly** (surrounding whitespace forgiven), an acknowledgement ("everyone loses access, and webhooks, API keys and
  automations stop"), and a reason (5+ characters). The OWNER role is re-read from the database inside the transaction (a stale Actor for a since-demoted owner is refused). **ADMINISTRATOR cannot archive** - a service-layer
  rule, whatever the UI shows. An `API`, `AI` or `SYSTEM` actor holding the OWNER role is refused. The page suggests exporting reports first (links to the existing CSV exports); no new export feature.
- **Restore by an OWNER** (`restore`): from the chooser's "Archived companies" list. The user must be an active OWNER of that company. Restore is also refused while the person already owns the maximum number of **active** companies
  (otherwise archive -> create -> restore would be a way round the cap).
- **Platform admin** (`PlatformAdminService.archiveOrganization / restoreOrganization`): `/admin/organizations/[orgId]`, reason mandatory (10+ characters), archived status/filter in the directory, archived count on the dashboard. The admin gains
  these two writes **only**; the admin boundary test is unchanged and still proves the section touches no tenant data. Both are audited in `platform_admin_audit_logs` **and** in the organization's own `audit_logs` (as the platform, linked by
  `platformAuditId`). The two actions live in their own module (`admin/organizations/[orgId]/actions.ts`) and are proven to 404 for non-admins in `admin-archive-actions.test.ts`.
- Every archive/restore is one transaction under the organization row lock (the same serialisation point membership changes use), with its audit row.

### 17.4 Create another company

Chooser button, switcher item, `/app/new`. `OrganizationService.createAdditionalCompany` -> the **same** `createWithUniqueSlug` -> `createWithOwner` registration uses (extracted, with retries: a collision or a reserved slug such as `admin` gets a
random suffix; a unique-index race is mapped to the same error). The creator is OWNER in seat 1, the seat limit is the usual 2, starter system accounts are created, `organization.created` is audited (with `createdFromExistingAccount`), and the
form redirects into the onboarding wizard. **Cap: 5 active owned companies** per person (`MAX_OWNED_ACTIVE_COMPANIES` in `limits.ts`); archived ones and companies where the person is only an administrator/member do not count; the count and the
insert run in one transaction after locking the person's user row, so simultaneous requests cannot overshoot (tested: 5 racing creations at cap-2 yield exactly 2). **Throttle:** registration has no throttle today, so there was nothing to be consistent with
beyond the API's per-instance `AuthThrottle`; create-another-company reuses that class (10 attempts per person per hour, per server instance, best effort). The cap is the real limit.

### 17.5 Invite codes

**Why codes, not email-bound auto-claim.** There is no email delivery and **no email verification**. An invite tied only to an email address would let anyone register that address first and inherit access. So an OWNER/ADMINISTRATOR
(`membership:manage`, human only - an API key, AI agent or system actor is refused even with the role) creates an invite for an email + role and receives a **secret code, shown once**, to pass on out of band.

- **Format and storage.** `mmj_` + 32 base32 characters = **160 bits** from the OS CSPRNG. Only the SHA-256 is stored (a fast hash is right for a uniformly random 160-bit secret, as for API keys); the invite row keeps a 6-character non-secret display prefix. The code is returned to the
  creating form through the server action's **return value** (never a URL or query string) and shown once; it is never logged, never audited (`REDACTED_FIELDS` gained `inviteCode`, `invite_code`, `codeHash`, `code_hash` - deliberately not the bare word `code`, which account audits legitimately carry) and
  never listed (the list shows prefix, email, role, creator, expiry, status).
- **Rules at creation.** Writer-role confirmation is enforced server-side exactly like add-by-email, but `confirmWriteAccess` is **required** (no trusted caller omits it); READ_ONLY is preselected; expiry 7 days; at most 10 pending per company (under the organization lock); refused for an
  existing active member's email and for an archived company. Revoke is available for pending invites. All audited.
- **Redemption** (`InviteService.redeem`, from the chooser's "Join a company" or the optional field on the registration form). All enforced server-side: the code must match an unexpired, unrevoked, unused invite; the redeeming account's **normalised email must equal the invite's email**; the
  company must not be archived; the seat limit is checked **under the organization row lock** through the same `addMembership` as every other join, so a full company returns the *specific* seat-limit message and the invite **stays valid**; the invite is marked used in the same transaction, so two simultaneous
  redemptions of one code produce exactly one membership (tested with five racing calls; and two different invites racing for the last seat -> one wins, the other gets the seat message and stays pending). It writes `membership.created` (with `viaInviteId`) and `organization_invite.redeemed` in the company's log.
  Registration with a code redeems **after** the account exists and, if it works, the new user does **not** also get a personal company; if the code fails (invalid, throttled, full company) registration falls back to the normal path (their own company when they gave a business name) with a clear notice, and the account is never lost over a bad code.
- **Throttle (best effort, per server instance).** 5 failed attempts per window (15 min) per **person** and per **address** (first `X-Forwarded-For` hop), after which even a correct code is refused without being checked. Malformed input counts. A seat-limit refusal does not (the guesser would already hold a valid code). A success clears only the person's counter, not a shared address's. Like the API's failed-auth throttle the counters live in process memory: serverless instances each have their own and a cold
  start resets them, so it is not a security boundary - the boundary is the 160-bit secret plus the email match; the throttle just makes casual guessing cheap to refuse.
- **No enumeration.** Unknown, malformed, wrong-email, expired, revoked, used and archived-company all return **one identical message**. The only specific messages are ones the redeemer is already entitled to (their company is full; they are already a member) or that concern only them (throttled).
- **Honest limit.** Email binding is defence in depth, not proof of identity: with no verification, someone who both obtains a code *and* registered the invitee's address first could redeem it. The code is the secret; treat it like a password and revoke an invite you suspect leaked.

### 17.6 The invite lookup and why it is safe

Redemption runs **before** the redeemer is a member, so which company a code belongs to is unknown until it resolves - the same problem `api_key_index` solved in Phase 10 Slice 1, with the same answer. `organization_invites` is an ordinary tenant table (`organization_id`, RLS enabled + FORCED, the single-variable
policy, `mm_app`: `SELECT, INSERT` and `UPDATE` of only `revoked_at, revoked_by_user_id, used_at, used_by_user_id`; no DELETE). `organization_invite_index` is the narrow non-tenant lookup (listed in `RLS_EXEMPT_TABLES`):

- it holds **only** `code_hash -> (invite id, organization id)` (+ `created_at`) - no email, role, expiry or state; every decision is made against the RLS-protected invite row after the app opens `withTenant(<that organization>)`;
- `mm_app` has **`SELECT, INSERT` only** - no UPDATE (a hash can never be re-pointed or rewritten), no DELETE, no TRUNCATE (tested as the real role);
- a composite foreign key `(id, organization_id) -> organization_invites(id, organization_id)` means a row for an invite that does not exist in that organization cannot be inserted, and since the invite row is RLS-protected a transaction scoped to organization A cannot plant a hash that resolves into B (tested);
- what an attacker who could read the whole index learns: that some 160-bit-hash maps to some organization id. They cannot reverse the hash, and an invite id alone reads nothing (the invite row is invisible without the tenant context). That is strictly less than `api_key_index`, which carries a secret hash, scopes and a creator.

No new permission was needed (`membership:manage` covers it), so `PERMISSION_AREAS` is unchanged. The AI controller registry and the API scope whitelist contain nothing about archive, restore or invites (asserted structurally).

### 17.7 Audit

`organization.created`, `organization.archived`, `organization.restored`, `organization_invite.created|revoked|redeemed`, `membership.created` (with `viaInviteId`). Platform admin archive/restore additionally write `platform_admin_audit_logs`. No audit row, log line or list ever contains a code or its hash.

### 17.8 What is not covered

Permanent deletion (impossible through the app role by design - append-only tables deny DELETE - and deliberately not built; see `docs/operations.md`); email delivery of invites and request-to-join (no email infrastructure or verification); a persistent (database-backed) throttle; per-invite
rate limiting across instances; invite-by-link for already-registered users without a code; automatic expiry of archived companies; transferring ownership during archive (use the existing role change first).

## 18. The Automation Centre (Phase 10 Slice 3): actions without a human click

Master spec §75 (automation rules), §76 (the system learns only through explicit, controlled configuration), §77 (every automated process must have pause, override, undo where allowed, review and an audit trail), §87 (non-negotiables). Architecture and query budgets: `docs/architecture.md` §13. Developer-visible event: `docs/api.md` (`automation.triggered`).

An automation is the one place in the product where something happens **with no person clicking**. The Phase 6 autonomy slice already set the house rules: critical actions stay human-gated at every level; autonomous action only through explicit, narrow, org-configured allowlists; everything audited, pausable and undoable. The Automation Centre obeys them by construction, not by convention.

### 18.1 Closed vocabulary - no code, no expressions

A rule is `{ trigger, triggerParams, conditions[], action }` and every part comes from a closed list in `src/domain/automation/vocabulary.ts`:

- **Triggers (11):** eight outbox events (`customer.created`, `supplier.created`, `invoice.created`, `invoice.sent`, `invoice.paid`, `payment.received`, `bill.created`, `bill.approved`) and three bounded condition scans (`INVOICE_OVERDUE`, `BILL_DUE_SOON`, `INVENTORY_BELOW_REORDER`). `automation.triggered` is deliberately **not** a trigger.
- **Conditions:** `{ field, operator, value }`. `field` must be in a **fixed whitelist per trigger** (e.g. `total`, `amount_due`, `customer_id`, `currency`, `days_overdue`, `quantity_on_hand`, `shortfall`); `operator` is one of `eq neq gt gte lt lte in`, restricted by the field's kind; `value` is a **literal checked against the kind** - a decimal *string* for money and quantities (a JS number is refused: no floats), an integer, a UUID, a fixed enum member, a 3-letter currency. All conditions are ANDed; at most 5.
- **Actions (4):** `NOTIFY_IN_APP`, `SEND_TO_CHANNEL`, `EMIT_WEBHOOK_EVENT`, `CREATE_DRAFT_PURCHASE_ORDER` (only with `INVENTORY_BELOW_REORDER`).
- A condition is **data that is compared, never parsed or evaluated.** There is no expression language, no `eval`/`new Function`/`vm`, no template substitution (a custom message is inserted as inert text; `{{x}}`, `${x}` and `%s` stay literal), and no SQL fragment: the scans **compile** a validated condition into SQL through closed lookup tables (field -> fixed SQL expression, operator -> fixed SQL operator) with the value as a **bound parameter**; `sql.raw` is only ever given a constant (asserted by a structural test over the source). Injection-looking text is accepted only in the rule's name/note/message (stored and rendered as text) and refused in every structural position.
- **Re-validated on every run.** A stored rule is not trusted: each evaluation pass re-runs the full validation on the stored row (`validateRuleSpec`) and switches off any rule that no longer passes (`INVALID_RULE`, visible reason, system audit entry). A test forges `trigger = 'automation.triggered'` and a condition field of `1=1; DROP TABLE invoices` directly in the database and shows the rule is disabled and nothing executes.

### 18.2 The action set is low-risk and reversible - and the excluded ones are unreachable

| Action | What it does | Undo |
|---|---|---|
| `NOTIFY_IN_APP` | one notification per eligible recipient (roles / named people), only to people whose role can already see the object | each person dismisses it |
| `SEND_TO_CHANNEL` | a short text message to a CONNECTED channel integration (Slack-compatible); amounts only if that connection opted in | delete the message in the channel; nothing in the books changes |
| `EMIT_WEBHOOK_EVENT` | an `automation.triggered` outbox event (`origin = automation`) delivered through the existing webhook subscriptions; payload = rule id/name, trigger, subject id, the **public-API DTO** | nothing changes here; the receiver decides |
| `CREATE_DRAFT_PURCHASE_ORDER` | a **DRAFT** PO for the product's preferred supplier at its reorder quantity through `PurchaseOrderService.createIn` | an ordinary draft, flagged "Automation" in the UI; edit or delete it |

**Not available as automation actions, enforced structurally** (not by a list someone has to remember to extend): posting, approving or voiding anything; creating payments or payment runs; bank-detail changes; payroll or employee anything; journal entries; period close, lock or reopen; membership, role or seat changes; API-key, webhook or integration management; AI autonomy settings. They cannot be expressed (the action enum has four members), and the execution identity could not perform them if they could (18.3). `src/tests/unit/automation/exclusions-and-identity.test.ts` **walks the action enum and the action->permission and trigger->permission mappings** and proves none maps to a forbidden permission; walks every write permission in the system (>50) and proves each (except `purchase_order:manage`) is outside the automation allow-list; and a structural test proves the engine imports no human-only service (periods, payroll, payments, journals, membership, API keys, subscriptions, AI autonomy). Even `purchase_order:manage` is narrowed: `PurchaseOrderService` calls `assertNotAutomation` first in `update`, `deleteDraft`, `markSent`, `cancel`, `close`, `recordReceipt` and `convertToBill`, so the identity can create a draft and nothing else about a PO (tested).

### 18.3 The execution identity: a distinct non-human actor that can only shrink

Automations run as actor type **`AUTOMATION`** (added to `ActorType` and the `audit_actor_type` enum exactly as `API` was in Slice 1: migration `0048` `ALTER TYPE ... ADD VALUE`). Every human-only check asks "is this actor a HUMAN?" - `assertHumanWith` (period close/reopen/sign-off), `evaluatePosting` (lock overrides), `evaluateLockChange`, and the webhook / API-key / integration / automation / invite / archive guards - so an `AUTOMATION` actor is refused **even with an OWNER role behind it** (tested for every one of them with a raw OWNER actor typed `AUTOMATION` and with a real built identity).

Its permissions are recomputed **on every run** as

> (permissions the rule's action + trigger need) **∩** (the authorising person's CURRENT role) **∩** (a short allow-list: reads plus `purchase_order:manage`), minus anything matching the forbidden pattern

carried as `Actor.grantedPermissions`, which `assertPermission` consults in addition to the role. Each factor can only remove power. In addition the authorising person must still hold `automation:manage` and be an active, non-suspended member **at run time**. The "authorising person" (`authorised_by_user_id`) is the rule's creator, and changes to whoever last edited or re-enabled it - a fresh, explicit human approval. When that person is removed, suspended, or demoted below `automation:manage` (or loses a permission the action needs), the **next pass switches the rule off** with a visible reason (`AUTHORISER_INACTIVE` / `AUTHORISER_LACKS_PERMISSION`) and a system audit entry; it is never silently deleted, and the rules page also shows "will be switched off at the next run" *before* that pass. Audit rows written by an automation (including those the domain services write themselves) record `actor_type = AUTOMATION`, the authorising user as `actor_user_id`, and `metadata = { viaAutomation, automationRuleId, automationRuleName, automationAuthorisedBy }`.

### 18.4 Controlled configuration is the authorisation (§76)

Creating, editing, enabling, deleting a rule, the "pause all" switch and "Run automations now" need the new permission **`automation:manage`** (OWNER and ADMINISTRATOR only) **and** a HUMAN actor; an API key, AI agent, system or automation actor is refused. `automation:read` (ACCOUNTANT, BOOKKEEPER, MANAGER, READ_ONLY, plus the two above) lets a role *see* rules and the run log. A write-type action (the draft PO) shows a clear warning on the form and the server **requires an explicit acknowledgement** (`acknowledgeWriteAction`) at creation and at every re-enable. References are checked at creation: a channel must be a CONNECTED, send-capable connection of the same organization; named people must be active members. The system learns nothing on its own: there is no feedback loop from outcomes into rules.

### 18.5 Pause, override, undo, review (§77)

- **Per rule** enable / pause (`USER_PAUSED`), with the reason shown.
- **Org-wide "Pause all automations"** (`automation_settings.all_paused`): read by the engine in the first statement of **every** pass with **no caching**, so it applies to the very next evaluation from any source (button, post-response task, outbox dispatch); tested. Events that occur while paused are **not replayed** after resuming (the resume time is a floor for events) - a pause means "do not act on what happened meanwhile".
- **Run log** `automation_runs`: **append-only** (`mm_app` has INSERT + SELECT only; UPDATE, DELETE and TRUNCATE denied, verified as the real role). Each row: rule (id + name snapshot), trigger, job key, attempt, outcome `SUCCESS` / `SKIPPED` / `FAILED` with a reason, actor (`AUTOMATION` + the authoriser), source (`MANUAL` / `POST_RESPONSE` / `OUTBOX_DISPATCH`), timestamps, and a link to the object it created. Deleting a rule keeps its history (`rule_id` is nulled by the owner-run foreign-key action).
- **Undo where meaningful.** Automation-made draft POs are flagged (`purchase_orders.automation_rule_id`, badge in the list and detail) and deletable as normal drafts by a person; notifications are dismissible.
- **Auto-disable** after 5 consecutive failed runs (`AUTO_FAILURES`), with the reason and a system audit entry; a person re-enables it (clearing the counter).
- **Archived organizations do not run**: the pass reads `archived_at` in the same statement as its try-lock and returns before loading a rule or touching an event, so an archived company's events stay pending and flow after a restore (tested). The entry-point table in `archived-entry-points.test.ts` lists the new modules.

### 18.6 Loop and flood protection

- **Dedupe is a database fact:** `automation_jobs` has `UNIQUE (rule_id, job_key)`; a job is *claimed* by inserting its row `ON CONFLICT DO NOTHING`, so a rule fires **at most once per trigger key** however often, and from however many instances, passes run. Keys: `event:<event id>`; `invoice:<id>:overdue:<N>`; `bill:<id>:due_soon:<N>`; `reorder:<product id>`. The reorder key is **deleted when the product recovers above its reorder point** (re-arm), and a job that was only SKIPPED for a missing supplier / reorder quantity re-arms once that is fixed; tested through two cycles.
- **No automation -> event -> automation cycle:** events an automation emits carry `origin = automation`, are stored pre-marked as processed, are excluded by the evaluator's query (`origin = 'user'`), `automation.triggered` is not an allowed trigger, and the column `origin` is immutable for `mm_app` (UPDATE grant is only on the two processing flags). Four independent layers; each tested.
- **Caps (constants in `vocabulary.ts`):** 10 runs per rule and 30 per organization per pass; 100 per rule and 300 per organization per rolling 24 h. Per-pass overflow waits for the next pass (events stay unprocessed, scans are found again); a daily overflow is recorded as a SKIPPED run so it can never wedge the queue. Scans examine at most 25 rows per rule per pass.
- A rule only reacts to events from **after it was last created, edited or enabled**, and never to events older than 72 h.
- **No connection across I/O:** a channel send reads its plan in a transaction, sends with **no transaction open**, and records the result in a second one (tested at the instant the client runs). Sequential only; no `Promise.all`, no private connection, no timers (structural test).

### 18.7 Notifications (minimal §66 slice)

`notifications` is a tenant table (RLS + FORCE + policy). One row per recipient, **resolved at creation** from roles / people, so nobody sees an item addressed to someone else's role. Visibility is a **service rule on top of RLS**: every read and change filters on `recipient_user_id = actor.userId`, and only a HUMAN actor may use the inbox (tested: an OWNER or ADMINISTRATOR colleague, another organization, and API / AI / automation / system actors see nothing and change nothing). The recipient filter also drops anyone whose role could not see the object. A notification's text, link and recipient are immutable for `mm_app` (column-level UPDATE grant: `read_at, dismissed_at, occurrences, last_occurred_at` only). Identical unread items fold into one with a count. **No unread-count query exists in the shared layout, shell or `withTenant`** (structural test): the count is computed only on the notifications page and the home card. Retention purge is on demand and audited. Reading, dismissing and clearing one's own inbox is deliberately **not** audited (it is personal inbox state, not a change to the books, and would bury the audit log); the creation of every notification is covered by the run log and the run's audit row.

### 18.8 What is not covered

A scheduler (owner decision); email/SMS actions (no email infrastructure); approval routing (§45 engine not built); supplier-bank-change blocking (no such event); month-close-complete trigger (cost); multi-step or branching workflows; automation via the public API; per-user notification preferences, digests and mobile push; per-instance fairness between organizations running passes at the same moment (the advisory lock makes a concurrent pass for the *same* organization return `busy`, but nothing limits how many organizations run at once).

## 19. Integrations (Phase 10 Slice 3): credentials at rest, the Slack destination, human-only management

Master spec §53. Design: `src/domain/integrations/*`; developer-facing notes in `docs/architecture.md` §13.

### 19.1 Secrets: the same machinery as webhook signing secrets

An integration's secret fields (for Slack: the incoming-webhook URL, which is a **bearer secret**) are split from the public settings by the provider's `validateConfig`, serialised and encrypted with **AES-256-GCM under the existing `WEBHOOK_SECRET_ENCRYPTION_KEY`** (key-versioned, rotation via `..._V<n>`; no new variable). The helper was generalised to `src/domain/security/secret-encryption.ts`; the webhook module re-exports it unchanged and the `webhook` purpose keeps its original additional authenticated data **byte for byte**, so every stored webhook secret still decrypts (tested by decrypting with the original AAD format). Integration ciphertexts are bound by AAD to `(purpose = integration, organization, connection id)`: a ciphertext cannot be moved to another connection, another organization, or presented as a webhook secret (all tested). Secrets are entered in a password field that is never pre-filled, **shown once, never returned** (the connection DTO carries only a masked rendering: host + the last four characters), never written to the audit log, the integration log, job contexts or run reasons (tested by dumping every related table), and decrypted only just in time, outside any transaction. `REDACTED_FIELDS` gained `webhookUrl`, `secretConfig`, `secretKeyVersion`. **Fail closed:** with the key unset or malformed, creating, testing, reconnecting and sending are refused with a clear message; disconnecting (which erases the stored ciphertext) and listing still work; the application and build are unaffected (`db:migrate` prints an optional-feature note).

### 19.2 The Slack provider's destination: allowlist AND the SSRF guard

Only a Slack-compatible incoming webhook is real. Every destination is checked, at connect time **and again on every send** (a stored row is not trusted), in this order:

1. **Host allowlist** `SLACK_ALLOWED_HOSTS = ["hooks.slack.com"]` - exact match after URL parsing, plus a path shape `/services/<T>/<B>/<token>` and no query. Refused by the allowlist (table in `slack-and-registry.test.ts`): `hooks.slack.com.evil.com`, `evilhooks.slack.com`, `api.slack.com`, `slack.com`, `hooks-slack.com`, userinfo tricks in both directions (`hooks.slack.com@evil.com`, `evil.com@hooks.slack.com`), a backslash host trick, any non-443 port, `http://`, scheme-less input, loopback / private / link-local / metadata IP literals in every spelling (decimal, hex, IPv6), `localhost` and internal suffixes, fragments, query strings, extra or missing path segments, traversal and encoded slashes, control characters and over-long input.
2. **The full webhook SSRF guard** (`parseWebhookUrl`, `resolveAndVet`, the pinned-IP transport): https only, port 443, no credentials, every DNS answer must be public (an allowlisted name that resolves to a private address, or to a mix, is refused - rebinding / poisoning), the socket connects to the **validated IP**, **no redirects** (a 3xx is a recorded failure), 10 s timeout, 8 KB response cap, **TLS verification never disabled**. The Slack provider calls the very same `sendWebhook` client; there is no second HTTP path (structural test: no `fetch`, `https`, `net`, `axios` in the new modules).

Because the allowlist can only narrow what the guard allows, a refused destination never invokes the client **or even the resolver** (asserted by the fake client's and resolver's call counts). The message is Slack's documented simplest payload `{ "text": ... }`: plain text, minimal content (what happened and a link back), amounts only when the connection's "include amounts" toggle (off by default) is on, and Slack's three control characters (`& < >`) escaped so text can never become a mention, a channel ping or a link. `testConnection` sends a clearly-labelled test message. **Microsoft Teams is deferred - mechanism unverified** (its incoming-webhook mechanism is being changed by Microsoft and could not be checked offline); it is listed as "coming soon" with that reason. Slack delivery was verified only through the injected fake client and a real local TLS server, never to Slack itself.

### 19.3 Human-only management; unreachable from the API, the AI and automations

`integration:manage` (OWNER / ADMINISTRATOR) **and** a HUMAN actor are required for every management operation (`list`, `create`, `test`, `reconnect`, `updateSettings`, `disconnect`, `remove`, the log). API keys, AI agents, automations and the system are refused (tested per operation). `integration:manage` is in no API scope, no AI tool and no automation action's permission set; the AI controller registry, the auto-execution allowlist and the API scope list contain nothing integration-related (asserted), and no AI, API or route module imports the integration modules (structural test). `SEND_TO_CHANNEL` only *uses* a connection a human configured: it needs `automation:read` and a connection that belongs to the same organization, is CONNECTED and whose provider declares the `send` capability.

### 19.4 Registry honesty

`IntegrationProvider` (id, name, category, capabilities, config schema, secret fields, `validateConfig`, `connect`, `testConnection`, `disconnect`, optional `send` / `handleDomainEvent`) is the plug-in contract; `getProvider` resolves **only implemented providers**. Every other integration in §53 (Basiq / Plaid / Yodlee, Stripe / PayPal / Square, Shopify / WooCommerce / Amazon / eBay, HubSpot / Salesforce, payroll / HR, Gmail / Outlook, Drive / OneDrive, Teams) is a data-only "coming soon" descriptor with the reason it needs (credentials, OAuth app, partner agreement); a test proves none resolves to a provider, none can be connected, and none carries a function. There are no stub connectors that pretend to work.

### 19.5 Connection health and the log

`integration_connections.status` is `CONNECTED` / `ERROR` / `DISCONNECTED`. A failed test sets `ERROR` with the reason; three consecutive failed automation sends set `ERROR` (audited, `integration.error_flagged`) and further sends fail fast until a person tests it successfully. `integration_events` is the append-only log (INSERT + SELECT only for `mm_app`): connect, test, send, disconnect, error - with a sanitised, length-capped detail and **never a secret**.

### 19.6 What is not covered

OAuth 2.0 and every OAuth-based provider; inbound webhooks from third parties; Teams; per-provider rate limiting beyond the automation caps; re-encrypting stored credentials on key rotation (they re-encrypt when the credential is next replaced, like webhook secrets).

## 20. OAuth 2.0 for third-party apps (Phase 10 Slice 4): consent, PKCE, token storage, the intersection rule

Master spec §54 ("OAuth for third-party apps"). Design: `src/domain/oauth/*`; the endpoints are `/oauth/authorize` (+ `/oauth/authorize/decision`), `/api/oauth/token`, `/api/oauth/revoke` and `/.well-known/oauth-authorization-server`; the developer guide is `docs/api.md` §1a; the per-request database budget is `docs/architecture.md` §14. An API key (§15) is a credential an Owner mints for **their own server**. An OAuth access token is a credential a **third party** holds, **on behalf of one person who explicitly consented**. Everything the API already guarantees (scopes, drafts-only, rate limiting, idempotency, RFC 7807 errors, archived-organization refusal) applies unchanged; this section is what is *new*.

### 20.1 Threat model

| Threat | Control |
|---|---|
| Stolen authorization code (log, Referer, history, a malicious app on the device) | **PKCE is required for every client, S256 only** (no `plain`, no way to register a client that skips it). The code is single-use, valid 60 s, bound to client + redirect URI + challenge + user + organization, and stored only as a SHA-256. The verifier never leaves the client. |
| Code replay | Atomic `UPDATE ... WHERE used_at IS NULL RETURNING` claim. A second presentation fails **and revokes the grant the first use created** (tokens and all) with an `oauth_code.replayed` audit row. Any failed check after the code is found (wrong client, wrong `redirect_uri`, bad verifier) **burns** the code. |
| Open redirect / redirect-URI manipulation | Redirect URIs are registered and matched **exactly** (https only, plus `http://localhost`, `127.0.0.1`, `[::1]` with any port for native/dev apps per RFC 8252); wildcards, fragments, userinfo, other schemes and plain http for real hosts are refused at registration. The authorize endpoint **never redirects to a URI that did not match**: an unknown client, an unregistered `redirect_uri`, a disabled app or an archived organization renders an **error page** (fixed message keys, nothing reflected). Only after the client **and** redirect URI are proven good are other errors (missing `state`, bad scope, no PKCE) returned to that redirect, with `iss` (RFC 9207). |
| Authorization CSRF | `state` is **required**. The Allow/Deny POST is a same-origin form post defended four ways: form content type; an `Origin` header equal to this site; the signed-in NextAuth session; and an **HMAC token bound to the person and to the exact request they were shown** (client, redirect URI, scope, state, challenge; keyed from `NEXTAUTH_SECRET` through a purpose-specific subkey; ten-minute expiry). The whole request is then **re-validated from scratch**: nothing in the form is trusted. |
| Clickjacking of the consent screen | The whole site sends `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` (`next.config.mjs`); a structural test pins both. |
| Consent skipped for a "trusted" app | There is no auto-approve, no first-party flag, no `prompt=none` and no remembered approval (a structural test greps the module for those words). The consent screen names the app, the organization, the person's own role, the scopes in plain English split into **read** and **create drafts**, states that nothing can be posted, approved, paid or deleted, and shows where the person will be sent. |
| Refresh-token theft | Refresh tokens **rotate on every use** by an atomic claim. Presenting an already-rotated token is **reuse**: the **whole grant is revoked** (every access token and the newest refresh token) with `oauth_token.reuse_detected` and `oauth_grant.revoked` audit rows (RFC 9700 §4.14). Two concurrent refreshes of one token: exactly one wins, the loser is treated as reuse. A rotated token is retained 7 days so reuse is detectable; afterwards a replay is merely an unknown token. |
| Token leakage at rest | Opaque random tokens (never JWTs; nothing is decoded), **only SHA-256 hashes stored** (§20.3), constant-time compares, labelled prefixes (`mmo_at_`, `mmo_rt_`, `mmo_ac_`, `mmo_cs_`) so secret scanners recognise them. No token, code, secret, verifier or hash is written to an audit row, a log line, a URL (other than the code in the redirect) or any response other than the one that mints it (tests dump every related table). |
| Token or secret in a URL | The token and revocation endpoints reject **any** query string and accept only a form body. The one exception is the authorization **code** in the redirect, as the protocol requires; the hand-off page sets `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. |
| Abuse of the token endpoint | Rate limited per address **and** per client id with the existing Postgres fixed-window counter (60/min per address, 300/min per client; `oauth_rate_windows`), **before** any other database work; 429 with `Retry-After`. Malformed credentials are rejected on shape with no query. Client-secret comparison is constant-time. |
| A third-party app escalating its own power | Scopes are the **same closed vocabulary as API keys** (10 scopes; none can post, approve, void, pay or delete). A scope outside the app's registered ceiling is `invalid_scope`; widening on refresh is `invalid_scope`; the consenting person's role must hold **every** permission behind each requested scope or the request is `access_denied`. Lowering an app's ceiling revokes grants that exceed it. |
| A third-party app administering the platform | No OAuth token reaches any human-only operation (§20.5). The new permission `oauth_app:manage` (OWNER/ADMINISTRATOR + a HUMAN actor) is in no scope, so an app cannot register an app, rotate its own secret or revoke others. |
| Cross-tenant access | §20.3: four tenant tables with FORCEd RLS; two non-tenant lookups whose **writes** are bound to the transaction's organization by policy; an app can only be authorised into the organization that registered it (§20.2). |
| Cookie-borne CSRF against the token endpoints | The middleware strips cookies from `/api/oauth/*` and refuses every method but POST (no preflight is ever answered); the routes never import the session layer. |
| Open CORS on the token endpoint | **No `Access-Control-*` header is ever sent** by the token or revocation endpoints (token requests come from an app's server or native code). The only OAuth response with a CORS header is the public RFC 8414 discovery document. |

### 20.2 Decision: apps are ORGANIZATION-SCOPED (not cross-organization)

An app is registered by an Owner/Administrator **of one organization** and can only ever be authorised **into that organization**. A person who belongs to several organizations must be a member of the app's organization to consent, and consenting never touches their other companies. Why:

1. **Who vouches for an app.** Registration is an Owner/Administrator's decision about *their* company (it names the redirect URIs that may receive their data). If an app registered by organization A could be authorised into B, B's members would be trusting a registration B's administrators never reviewed, and an attacker could register a convincing "Accounting Sync" app in a throw-away organization and phish members of unrelated companies through a real consent screen.
2. **Blast radius.** A compromised or malicious app is contained to the organization whose administrators accepted it; disabling or deleting it there ends it everywhere it could ever have been used.
3. **Row-level security stays one-id-per-transaction.** A cross-organization app would need a platform-level client table and a "user consented in organization X" fan-out, i.e. cross-tenant reads the isolation model (§2) deliberately forbids.

The cost: a vendor serving many customers has one client id per customer organization. A platform-level "published app" with a review process is **deferred**; the data model (client index -> organization) is what such a feature would extend.

### 20.3 Token storage and the lookup indexes

| Table | Kind | Holds | `mm_app` may |
|---|---|---|---|
| `oauth_apps` | tenant (RLS + FORCE + policy) | registration, redirect URIs, scope ceiling, SHA-256 of the client secret | SELECT, INSERT; UPDATE only the editable columns (never organization, client id, type, creator); no DELETE (soft delete) |
| `oauth_grants` | tenant | one row per consent that minted tokens: user, app, scopes, revocation stamp + reason | SELECT, INSERT; UPDATE only `last_refreshed_at` and the revocation columns; never DELETE |
| `oauth_authorization_codes` | tenant | SHA-256 of the code, redirect URI, PKCE challenge, scopes, expiry, `used_at`, `grant_id` | SELECT, INSERT, DELETE (purge); UPDATE only `used_at` and `grant_id` |
| `oauth_refresh_tokens` | tenant | SHA-256 of the token, expiry, `used_at` | SELECT, INSERT, DELETE (purge); UPDATE only `used_at` |
| `oauth_client_index` | **non-tenant lookup** | client id -> (app, organization, type). **Immutable** | SELECT, INSERT only |
| `oauth_access_tokens` | **non-tenant lookup** | prefix, SHA-256, grant, app, client id, user, organization, scopes, expiry, `revoked_at` | SELECT, INSERT; UPDATE only `revoked_at`; DELETE (grant-scoped purge of long-expired rows) |
| `oauth_rate_windows` | counters | text bucket -> window counter (no organization data) | SELECT, INSERT, UPDATE, DELETE (purge) |

Authorization codes and refresh tokens never need a global index: the token endpoint receives a **client id** with them, resolves the organization from the immutable `oauth_client_index` row, opens that organization's tenant transaction and looks the hash up under RLS. Only the **access token** is presented alone (`Authorization: Bearer ...`), so it, and only it, has a non-tenant index, exactly like `api_key_index`. Bearer authentication is **one joined query** (token row + the person's membership + account state + the organization's archive flag) plus one rate-limit statement: the same two statements an API-key request costs.

**Stronger than the earlier indexes.** A composite foreign key to an RLS-protected parent does not by itself stop a transaction scoped to organization B from inserting an index row naming organization A and an A-owned id it happens to know, because foreign-key checks bypass row-level security. So `oauth_client_index` and `oauth_access_tokens` additionally have FORCEd RLS with an **asymmetric** policy set (migration `0051`): `SELECT` is open (`USING (true)`: authentication runs before any organization is known, and the rows hold only ids, public metadata and hashes), while `INSERT`/`UPDATE`/`DELETE` require `organization_id = app.current_org_id`. A tenant transaction can therefore never mint, revoke or purge another organization's client or token rows (tested as the real role, including the forged-insert attempt). They stay in `RLS_EXEMPT_TABLES` (they are not "one policy keyed on the organization" tables); the build-time isolation audit stays clean.

**Revocation is a write in the same transaction as its cause.** Revoking a grant stamps the grant row **and** every access-token index row for it; disabling or deleting an app, a code replay, a refresh reuse, a user's or an administrator's revoke, and lowering an app's scope ceiling all go through one function (`grant-store.ts`). Refresh tokens need no stamp: the refresh path joins the grant and refuses a revoked one. So the next API request with any of the grant's tokens fails with `401 token_revoked`, and the next refresh with `invalid_grant`.

**Client secrets** (confidential clients): `mmo_cs_<tag6>_<256 bits>`, **shown once** (returned only to the form that registered or rotated), stored as SHA-256 in `oauth_apps.secret_hash`, compared in constant time, **rotatable** (the old secret stops working at once; existing grants are unaffected). Never returned by any listing, never in an audit row (tested by dumping every table). Public clients have neither a secret nor a hash. Client authentication is `client_secret_basic` or `client_secret_post`, never both; a public client presenting a secret, or a confidential client presenting none, is `invalid_client`.

### 20.4 The intersection rule (the access token's power) and the actor type

A token's power is **never stored**. On **every** request:

```
effective permissions  =  permissions behind the granted scopes
                          INTERSECT  the consenting person's CURRENT role permissions in that organization
                          INTERSECT  API_ALLOWED_PERMISSIONS  (the pinned whitelist)
```

It is the function API keys use (`effectivePermissions`), fed the person who **consented** instead of the person who created a key. Each consequence is an integration test against the real database:

- **Demotion** (e.g. BOOKKEEPER -> READ_ONLY) shrinks the token on the very next call (`403 permission_denied` for the lost writes; reads continue; `GET /me` shows the new set).
- **Removal / seat removal** (`is_active = false`), **suspension** (`users.disabled_at`) and an **archived organization** end it on the next call (`401 authorization_owner_inactive` / `403 organization_archived`); refresh is refused too. Restoring an archived organization brings the same token back untouched.
- A role that gains power does not widen a token (scopes bound it). A role that cannot hold a scope's permissions cannot consent to that scope at all.
- Writes are **drafts only**, by the same mechanism as keys: the `API` actor type, the whitelist (`contact:manage`, `customer_invoice:manage`, `supplier_bill:manage` are the only write permissions reachable) and the draft guard that refuses dates in any locked period.

**Actor type decision: `API`, not a new `OAUTH` type.** The token resolves to an `Actor` of type `API` carrying `Actor.oauth = { clientId, grantId }` (instead of `Actor.apiKey`), with `userId` = the consenting person. A new enum value would have to be threaded through every `type === "HUMAN"` check, the `audit_actor_type` enum (a migration, as `API` and `AUTOMATION` needed) and every exhaustive switch, for no security gain: the property that matters is "not human", which `API` already has everywhere (`assertHumanWith`, `evaluatePosting`, the webhook / integration / automation / API-key / OAuth-app guards, `PurchaseOrderService`, ...). Distinguishability is kept where it matters: `AuditService.record` merges `{ viaOAuth: true, oauthClientId, oauthGrantId, oauthAuthorisedBy }` into **every** audit row such an actor writes, including rows domain services write on their own, so an auditor can tell "API key X" from "app Y acting for Alice". Protocol-level events (grant created, replay, reuse, revoked by the client) are written by the authorization server as `SYSTEM` rows naming the client id and the person in the payload. Tests put an OWNER behind the token.

### 20.5 Exclusion proof: what no OAuth token can ever do

An OAuth token cannot: post, approve, void, reverse, pay or delete anything; close, reopen or lock a period; manage members, roles or seats; create, list or revoke API keys; manage webhooks, integrations, automations or **OAuth apps** (registering an app, rotating its secret, listing or revoking other people's grants); touch billing, payroll, employees, bank accounts or rules, tax codes, practices, consolidation or platform admin. Enforcement is structural, not a list:

1. The scope table is closed and every scope maps inside `API_ALLOWED_PERMISSIONS` (pinned by test).
2. `effectivePermissions` intersects with that whitelist, so even a hand-edited scope string in the database grants nothing.
3. The actor is type `API`, which fails every `type === "HUMAN"` guard.

`src/tests/unit/oauth/exclusions.test.ts` **walks every permission in the system** with an OWNER-backed OAuth actor holding *all ten scopes*: every permission outside the whitelist is refused by `assertPermission` although the OWNER role holds it; of all write permissions the only holdable ones are exactly `contact:manage`, `customer_invoice:manage` and `supplier_bill:manage`; every `post / void / approve / reverse / reopen / close / override` permission is refused and forbidden-by-pattern; the named administrative permissions (including the new `oauth_app:manage`) are refused; and `assertHumanWith`, `assertHumanWebhookManager`, `assertHumanIntegrationManager`, `assertHumanAutomationManager` and `evaluatePosting` refuse the actor even when `grantedPermissions` is forged to include their permissions. `oauth-app-management.test.ts` proves, method by method, that every role other than OWNER/ADMINISTRATOR, and every non-human actor type (OAuth, API key, AI, system, automation) with every permission, is refused by the app and grant services and by `ApiKeyService`.

### 20.6 Management: who can see and do what

- **Settings > Connected apps** (`/[orgSlug]/settings/oauth-apps`): `oauth_app:manage` (OWNER/ADMINISTRATOR) **and** a HUMAN actor. Register (name, description, homepage, redirect URIs, scope ceiling, public/confidential), edit, rotate the secret, disable/enable, delete, see each app's active authorisations and revoke any. Capped at **10 apps per organization** (deleted ones do not count). Everyone else sees only an explanation. **Disabling or deleting an app revokes all of its grants in the same transaction**; re-enabling does not bring them back (people must consent again).
- **Authorised apps** (`/app/authorised-apps`): any signed-in member lists the apps they have authorised in each company they belong to and removes any of them. Not a permission (withdrawing your own consent never is) but still HUMAN-only. Companies are read one at a time; archived ones are skipped. Someone else's grant is reported as not found, never as forbidden.
- **Audit** (the organization's own log; HUMAN actor with the person's id): `oauth_app.created / updated / secret_rotated / disabled / enabled / deleted`, `oauth_consent.approved / denied`, `oauth_grant.created`, `oauth_grant.revoked` (reason `USER`, `ADMIN`, `APP_DISABLED`, `APP_DELETED`, `APP_SCOPES_REDUCED`, `CODE_REPLAY`, `REFRESH_REUSE` or `CLIENT`), and the anomalies `oauth_code.replayed / client_mismatch / redirect_mismatch / pkce_failed`, `oauth_token.reuse_detected / client_mismatch`. Each names the client id and the person; none contains a token, code, secret, verifier or hash (`REDACTED_FIELDS` also gained `accessToken`, `refreshToken`, `clientSecret`, `authorizationCode`, `codeVerifier`, `tokenHash` as a net).
- Not surfaced in the platform admin section (it is organization data; nothing there was trivially consistent).

### 20.7 Standards followed, and deliberate omissions

RFC 6749 (authorization-code grant **only**; implicit, resource-owner password and client-credentials answer `unsupported_grant_type`), RFC 7636 (PKCE, S256, required), RFC 7009 (revocation: either token revokes the grant; unknown tokens answer 200), RFC 8414 (metadata), RFC 8252 (loopback redirects), RFC 9207 (`iss` in the authorization response), RFC 9700 (exact redirect match, refresh rotation + reuse detection, short-lived access tokens, no tokens in URLs), RFC 6750 (`WWW-Authenticate: Bearer error="invalid_token"` on a 401). **Not built:** token introspection (RFC 7662: apps never need to introspect their own opaque tokens, and a safe implementation is not trivial), dynamic client registration (RFC 7591: registration is a human decision by design), custom-scheme / claimed-https native redirects (use loopback), `prompt=none`, scope step-up on an existing grant, the device-code grant, and a platform-level cross-organization app (§20.2).

### 20.8 Known limits

The OAuth rate limits are in Postgres (shared across instances) but keyed on the address a proxy reports (`X-Forwarded-For`), so a client able to spoof it can spread across address buckets; the per-client-id bucket still bounds it. The reuse-detection window is 7 days after rotation. A client that loses the response to a refresh (network failure after the server rotated) holds a spent token and will, on retry, trigger reuse detection and need a fresh consent: the documented trade-off of strict rotation (clients must persist the new refresh token before using it). The consent hand-off is an interstitial page rather than a 3xx because browsers apply the consent page's `form-action 'self'` CSP to a form's redirect chain; that was reasoned from the CSP specification and **not** observed in a real browser. The visual layout of every new page is unverified.
