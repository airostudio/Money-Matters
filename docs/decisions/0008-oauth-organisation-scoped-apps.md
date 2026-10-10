# 0008 — OAuth 2.0: organisation-scoped apps, `API` actor type, write-bound lookup indexes

Status: accepted (Phase 10 Slice 4). Detail: `docs/security.md` section 20, `docs/architecture.md` section 14, `docs/database.md` section 2v.

## Context

Third-party applications need to act on a company's data on behalf of a person who consents, as an alternative to a manually
created API key. The platform's invariants must hold unchanged: tenant isolation by row-level security with one scope id per
transaction, "an integration prepares a draft, a person posts it", effective permission recomputed from the person's *current*
role, and every human-only operation unreachable by anything that is not a signed-in person.

## Decisions

1. **An app belongs to one organisation and can only be authorised into it.** It is registered by that organisation's Owner or
   Administrator (`oauth_app:manage`, human only). The alternative — a platform-level client that any member of any organisation
   can authorise — was rejected: (a) the administrators of organisation B would be trusted with a registration they never
   reviewed, which turns a real consent screen into a phishing vector; (b) a compromised app is no longer contained to the
   organisation that accepted it; (c) it needs cross-tenant reads (client -> every organisation a person belongs to) that the
   isolation model forbids. The cost — one client id per customer organisation for a vendor serving many — is accepted; a reviewed
   "published app" marketplace is deferred.
2. **An access token resolves to an `API` actor, not a new `OAUTH` actor type.** The property every guard needs is "not human",
   which `API` already has in every `type === "HUMAN"` check, the period-lock decision functions, the webhook / integration /
   automation / API-key guards and the purchase-order service. A new enum value would add a migration and an edit to every
   exhaustive switch for no security gain. The distinction auditors need is kept in `Actor.oauth` and merged by `AuditService` into
   every audit row (`viaOAuth`, client id, grant id, authorising person). Tests put an OWNER behind the token.
3. **Authorization-code grant with mandatory PKCE (S256 only) and rotating refresh tokens with reuse detection; nothing else.** No
   implicit, password or client-credentials grants; no `plain`; no introspection (not trivial to do safely, not needed by apps that
   hold opaque tokens); no dynamic registration (registration is a human decision).
4. **Opaque tokens, SHA-256 at rest; one non-tenant lookup per credential presented alone.** Codes and refresh tokens arrive with a
   client id, so they live in tenant tables and are found after the organisation is resolved from an immutable client index. Only
   the access token (a bare bearer) gets a non-tenant index, joined to membership/user/organisation in the same single query an API
   key uses, so an OAuth-authenticated request costs exactly what a key-authenticated one does.
5. **The two lookup indexes are write-bound by RLS, not only by a composite foreign key.** Foreign-key checks bypass row-level
   security, so the earlier "FK to an RLS-protected parent" argument does not stop a transaction scoped to B from naming A's ids.
   `oauth_client_index` and `oauth_access_tokens` therefore have FORCEd RLS with `SELECT USING (true)` (authentication precedes any
   tenant context) and INSERT / UPDATE / DELETE bound to `app.current_org_id`. `api_key_index` and `organization_invite_index` were
   not changed in this slice; the same hardening could be applied to them.
6. **Idempotency is scoped per credential, not per `api_keys` row.** `api_idempotency_keys.api_key_id` stopped being a foreign key
   so it can hold an OAuth grant id; namespaces cannot collide because ids are random UUIDs.

## Consequences

Disabling or deleting an app, lowering its scope ceiling, replaying a code, reusing a rotated refresh token, and a user's or an
administrator's revoke all end in one function that stamps the grant and its access-token index rows in the same transaction as the
cause. A client must persist each new refresh token before using the new access token (strict rotation). The consent decision hands
off through an interstitial page because of the site-wide `form-action 'self'` CSP (reasoned from the specification; not observed in
a browser).
