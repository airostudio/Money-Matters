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

## 3. AuthN / AuthZ

- **Phase 1 auth**: NextAuth Credentials provider, `bcrypt`-hashed passwords,
  Prisma adapter for sessions. MFA/passkey (WebAuthn) is architected for
  (session model supports multiple credential types) but not implemented in
  Phase 1 — tracked in `docs/roadmap.md`.
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
