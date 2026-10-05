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
role. A refusal from a service that bubbles up from any page or server action reaches the
org-level `error.tsx`, which recognises `PermissionDeniedError` through its `digest`
(Next.js hides the message in production but keeps a digest the error carries) and shows
the same explanation instead of a generic "Application error".

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
themselves.
