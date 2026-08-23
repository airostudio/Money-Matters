# 0002 — NextAuth (Credentials) for Phase 1, Supabase Auth as production target

## Status
Accepted for Phase 1; revisit before production launch.

## Context
The master spec directs using Supabase "where suitable" for auth, while
keeping the architecture portable. This session's environment has no live
Supabase project/credentials, and the app must be runnable and testable
(incl. automated tenant-isolation tests) without depending on an external
service being reachable.

## Decision
Ship Phase 1 with NextAuth.js, Credentials provider, Prisma adapter,
`bcrypt` password hashing. Design the session/actor model
(`src/lib/session.ts` → `Actor { userId, organizationId, role }`) so that
swapping the identity provider later only touches `src/lib/auth.ts` and the
sign-in route — no domain service, permission check, or audit call depends
on *how* the user authenticated, only on the resolved `Actor`.

## Alternatives considered
- **Supabase Auth now** — better aligns with the long-term target, but
  requires a live Supabase project, external network access during tests,
  and secret provisioning this session doesn't have. Deferred, not
  rejected.
- **Roll a fully custom auth stack** — more control, more surface area to
  get wrong in a security-sensitive app; NextAuth's Credentials provider
  already handles session/CSRF correctly.

## Consequences
- Before production launch: replace the Credentials provider with Supabase
  Auth (or NextAuth's Supabase adapter), migrate `User.passwordHash` off
  the app database, and add MFA/passkey (WebAuthn) support (tracked in
  `docs/roadmap.md`).
- `MembershipRole`/permission logic is unaffected by this swap by
  construction, since it hangs off `OrganizationMembership`, not off the
  auth provider's user table.
