import { describe, expect, it } from "vitest";
import { API_ALLOWED_PERMISSIONS, API_SCOPES, SCOPE_INFO, effectivePermissions, isForbiddenForApi, scopePermissions } from "@/domain/api/scopes";
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import { isWritePermission } from "@/domain/permissions/role-info";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { assertHumanWith } from "@/domain/close/period-lock-service";
import { assertHumanAutomationManager } from "@/domain/automation/guards";
import { assertHumanWebhookManager } from "@/domain/webhooks/subscription-service";
import { assertHumanIntegrationManager } from "@/domain/integrations/connection-service";
import { evaluatePosting } from "@/domain/ledger/period-lock";
import { resolveAccessToken, type AccessTokenRow } from "@/domain/oauth/bearer";
import { scopesBeyondRole } from "@/domain/oauth/authorize-service";
import { hashCredential } from "@/domain/oauth/credentials";

/**
 * The exclusion proof for OAuth (docs/security.md section 20): an OAuth access token can never hold ANY human-only,
 * posting, approving, paying, payroll, closing or administrative permission - however powerful the person who consented
 * (an OWNER here) and whatever scopes were granted. Mirrors the API-key and Automation Centre exclusion tests, with an
 * OWNER role behind the token so that "the role would have allowed it" is never what saves us.
 */
const ROLES = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];

/** What the three write scopes legitimately map to: creation of DRAFT documents and contacts, nothing else. */
const DRAFT_CREATE_PERMISSIONS: Permission[] = ["contact:manage", "customer_invoice:manage", "supplier_bill:manage"];

function tokenRow(scopes: string[], role: MembershipRole | null): AccessTokenRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    grantId: "00000000-0000-4000-8000-000000000003",
    appId: "00000000-0000-4000-8000-000000000004",
    clientId: "mmo_c_" + "a".repeat(22),
    userId: "00000000-0000-4000-8000-000000000005",
    prefix: "abcd1234",
    secretHash: hashCredential("token"),
    scopes,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    membershipRole: role,
    membershipActive: role !== null,
    userDisabledAt: null,
    organizationArchivedAt: null,
  };
}

/** The Actor the bearer layer hands to every domain service for an OAuth access token backed by an OWNER. */
function oauthActor(scopes: readonly string[] = API_SCOPES, role: MembershipRole = "OWNER"): Actor {
  return resolveAccessToken(tokenRow([...scopes], role), hashCredential("token"), new Date()).actor;
}

describe("an OAuth access token resolves to a non-human API actor", () => {
  it("is type API (so every human-only check refuses it), carries the consenting user and the client / grant, and is narrowed to its permissions", () => {
    const principal = resolveAccessToken(tokenRow([...API_SCOPES], "OWNER"), hashCredential("token"), new Date());
    expect(principal.actor.type).toBe("API");
    expect(principal.actor.role).toBe("OWNER");
    expect(principal.actor.oauth).toEqual({ clientId: "mmo_c_" + "a".repeat(22), grantId: "00000000-0000-4000-8000-000000000003" });
    expect(principal.actor.apiKey).toBeUndefined();
    expect(principal.actor.grantedPermissions).toBe(principal.permissions);
    expect(principal.credential).toBe("oauth");
  });
});

describe("walking EVERY permission: an OAuth actor behind an OWNER can hold only the whitelisted ones", () => {
  const actor = oauthActor();

  it("every permission outside the API whitelist is refused by assertPermission, although the OWNER role holds it", () => {
    let refused = 0;
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission("OWNER", permission), permission).toBe(true); // the role alone would allow EVERYTHING
      if (API_ALLOWED_PERMISSIONS.has(permission)) continue;
      expect(() => assertPermission(actor, permission), permission).toThrow(PermissionDeniedError);
      refused += 1;
    }
    expect(refused).toBe(PERMISSIONS.length - API_ALLOWED_PERMISSIONS.size);
    expect(refused).toBeGreaterThan(80);
  });

  it("every WRITE permission is refused except the three that create drafts / contacts; every other write needs a scope that does not exist", () => {
    const writes = PERMISSIONS.filter(isWritePermission);
    expect(writes.length).toBeGreaterThan(60);
    const holdable = writes.filter((p) => {
      try {
        assertPermission(actor, p);
        return true;
      } catch {
        return false;
      }
    });
    expect(holdable.sort()).toEqual([...DRAFT_CREATE_PERMISSIONS].sort());
  });

  it("every permission an action word marks as posting / voiding / approving / reversing / closing / reopening is refused and forbidden-by-pattern", () => {
    const critical = PERMISSIONS.filter((p) => /:(post|void|approve|reverse|reopen|reopen_hard|override_soft|post_advisor_locked|close|respond|ai_suggest|import|reconcile)$/.test(p));
    expect(critical.length).toBeGreaterThan(15);
    for (const permission of critical) {
      expect(isForbiddenForApi(permission), permission).toBe(true);
      expect(() => assertPermission(actor, permission), permission).toThrow(PermissionDeniedError);
    }
  });

  it("the administrative and human-only permissions are refused by name", () => {
    for (const permission of [
      "organization:manage", "membership:manage", "api_key:manage", "webhook:manage", "integration:manage", "automation:manage", "oauth_app:manage",
      "period:close", "period:reopen", "period:reopen_hard", "period:override_soft", "period:post_advisor_locked", "fiscal_period:manage", "close_checklist:manage",
      "journal:post", "journal:reverse", "customer_invoice:post", "customer_invoice:void", "supplier_bill:post", "supplier_bill:void",
      "customer_payment:manage", "supplier_payment:manage", "payment_run:manage", "payment_run:approve", "bank_account:manage", "bank_transaction:reconcile",
      "payrun:manage", "payrun:post", "payrun:read", "employee:read", "employee:manage", "expense_claim:approve", "timesheet:approve", "consolidation:manage",
      "tax_code:manage", "account:manage", "audit:read", "client_request:manage",
    ] as const) {
      expect(() => assertPermission(actor, permission), permission).toThrow(PermissionDeniedError);
      expect(API_ALLOWED_PERMISSIONS.has(permission), permission).toBe(false);
    }
  });

  it("the new permission is held by OWNER and ADMINISTRATOR only, is forbidden for the API, and is in no scope", () => {
    for (const role of ROLES) expect(roleHasPermission(role, "oauth_app:manage"), role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
    expect(isForbiddenForApi("oauth_app:manage")).toBe(true);
    for (const scope of API_SCOPES) expect(SCOPE_INFO[scope].permissions).not.toContain("oauth_app:manage");
  });

  it("the union of everything any scope can grant to an OWNER-backed token is exactly the API whitelist - and cannot be widened by a stored scope string", () => {
    const union = effectivePermissions([...API_SCOPES], "OWNER");
    expect([...union].sort()).toEqual([...API_ALLOWED_PERMISSIONS].sort());
    // A hand-edited scope list in the database (an unknown or a human-only 'scope') grants nothing.
    const smuggled = effectivePermissions(["period:close", "membership:manage", "*", "admin", "oauth_app:manage"], "OWNER");
    expect(smuggled.size).toBe(0);
    expect(scopePermissions(["root"]).size).toBe(0);
  });

  it("the consent screen cannot grant a scope the person's role does not fully permit", () => {
    for (const role of ROLES) {
      const beyond = scopesBeyondRole([...API_SCOPES], role);
      for (const scope of API_SCOPES) {
        const holdsAll = SCOPE_INFO[scope].permissions.every((p) => roleHasPermission(role, p));
        expect(beyond.includes(scope), `${role} ${scope}`).toBe(!holdsAll);
      }
    }
    expect(scopesBeyondRole(["invoices:write"], "READ_ONLY")).toEqual(["invoices:write"]);
    expect(scopesBeyondRole(["invoices:read"], "READ_ONLY")).toEqual([]);
  });

  it("intersection with the CURRENT role, for every role, can only remove power", () => {
    for (const role of ROLES) {
      const effective = effectivePermissions([...API_SCOPES], role);
      for (const permission of effective) {
        expect(roleHasPermission(role, permission), `${role} ${permission}`).toBe(true);
        expect(API_ALLOWED_PERMISSIONS.has(permission), `${role} ${permission}`).toBe(true);
      }
      const asToken = oauthActor(API_SCOPES, role);
      for (const permission of PERMISSIONS) {
        if (!effective.has(permission)) expect(() => assertPermission(asToken, permission), `${role} ${permission}`).toThrow(PermissionDeniedError);
      }
    }
  });
});

describe("every human-only gate refuses the OAuth actor, even with an OWNER behind it", () => {
  const actor = oauthActor();
  it("period close / reopen and sign-offs (assertHumanWith)", () => {
    expect(() => assertHumanWith(actor, "period:close")).toThrow(PermissionDeniedError);
    // And with the permission faked onto the actor, the TYPE alone still refuses it.
    const faked: Actor = { ...actor, grantedPermissions: new Set<Permission>(["period:close", "membership:manage", "api_key:manage", "oauth_app:manage"]) };
    expect(() => assertHumanWith(faked, "period:close")).toThrow(PermissionDeniedError);
  });
  it("API-key, webhook, integration, automation management", () => {
    const faked: Actor = { ...actor, grantedPermissions: new Set<Permission>(["webhook:manage", "integration:manage", "automation:manage", "api_key:manage"]) };
    expect(() => assertHumanWebhookManager(faked)).toThrow(PermissionDeniedError);
    expect(() => assertHumanIntegrationManager(faked)).toThrow(PermissionDeniedError);
    expect(() => assertHumanAutomationManager(faked)).toThrow(PermissionDeniedError);
  });
  it("posting into a locked period has no override for it (evaluatePosting with actor type API)", () => {
    for (const level of ["SOFT_LOCKED", "ADVISOR_LOCKED", "TAX_LOCKED", "HARD_LOCKED"] as const) {
      expect(evaluatePosting({ level, role: "OWNER", actorType: actor.type }).allowed, level).toBe(false);
    }
  });
});

describe("token resolution refuses everything it should (pure)", () => {
  const now = new Date();
  const h = hashCredential("token");
  it("wrong secret, revoked, expired, archived, no membership, inactive membership, suspended user", () => {
    expect(() => resolveAccessToken(tokenRow(["contacts:read"], "OWNER"), hashCredential("other"), now)).toThrowError(expect.objectContaining({ code: "invalid_token" }));
    expect(() => resolveAccessToken({ ...tokenRow(["contacts:read"], "OWNER"), revokedAt: now }, h, now)).toThrowError(expect.objectContaining({ code: "token_revoked" }));
    expect(() => resolveAccessToken({ ...tokenRow(["contacts:read"], "OWNER"), expiresAt: new Date(now.getTime() - 1) }, h, now)).toThrowError(expect.objectContaining({ code: "token_expired" }));
    expect(() => resolveAccessToken({ ...tokenRow(["contacts:read"], "OWNER"), organizationArchivedAt: now }, h, now)).toThrowError(expect.objectContaining({ code: "organization_archived" }));
    expect(() => resolveAccessToken(tokenRow(["contacts:read"], null), h, now)).toThrowError(expect.objectContaining({ code: "authorization_owner_inactive" }));
    expect(() => resolveAccessToken({ ...tokenRow(["contacts:read"], "OWNER"), membershipActive: false }, h, now)).toThrowError(expect.objectContaining({ code: "authorization_owner_inactive" }));
    expect(() => resolveAccessToken({ ...tokenRow(["contacts:read"], "OWNER"), userDisabledAt: now }, h, now)).toThrowError(expect.objectContaining({ code: "authorization_owner_inactive" }));
  });
  it("a demotion between two calls changes the answer, with the same row", () => {
    const row = tokenRow(["invoices:write", "invoices:read"], "BOOKKEEPER");
    expect(resolveAccessToken(row, h, now).permissions.has("customer_invoice:manage")).toBe(true);
    expect(resolveAccessToken({ ...row, membershipRole: "READ_ONLY" }, h, now).permissions.has("customer_invoice:manage")).toBe(false);
    expect(resolveAccessToken({ ...row, membershipRole: "READ_ONLY" }, h, now).permissions.has("customer_invoice:read")).toBe(true);
  });
});
