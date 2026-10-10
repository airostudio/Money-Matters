import { roleHasPermission, type MembershipRole, type Permission } from "./roles";

/**
 * `API` is a request authenticated by an API key (Phase 10 Slice 1). Like `AI` and `SYSTEM` it is NOT human, so
 * every human-only check (`type === "HUMAN"`: period close/reopen/override, sign-offs, ...) refuses it.
 *
 * `AUTOMATION` is a rule run by the Automation Centre (Phase 10 Slice 3). Same story: NOT human, so every human-only
 * check refuses it even when the rule's authorising person is an OWNER, and its `grantedPermissions` can only ever be
 * the action's required permissions intersected with that person's CURRENT role (src/domain/automation/identity.ts).
 */
export type ActorType = "HUMAN" | "AI" | "SYSTEM" | "API" | "AUTOMATION";

/**
 * The acting party for a domain-service call: a specific user, in a
 * specific organization, holding a specific role in that organization.
 * Every mutating (and most reading) domain service method takes an Actor as
 * its first argument and checks it via `assertPermission` before touching
 * the database — see docs/architecture.md §5 and docs/security.md §4.
 */
export interface Actor {
  userId: string;
  organizationId: string;
  role: MembershipRole;
  /** Defaults to HUMAN. Phase 6 AI agents pass "AI" so AuditService records it. */
  type?: ActorType;
  /**
   * When set, a NARROWING of `role`: the actor may use only the permissions in this set (and, as always, only
   * those its role also holds). Set for API-key actors to the key's scope-derived permissions already
   * intersected with the creator's current role. `assertPermission` consults it in addition to the role - it
   * can only ever remove power, never add it.
   */
  grantedPermissions?: ReadonlySet<Permission>;
  /** Present for an `API` actor: which key acted. Recorded in the audit metadata by `AuditService.record`. Never the secret. */
  apiKey?: { id: string; prefix: string };
  /** Present for an `AUTOMATION` actor: which rule acted. Recorded in the audit metadata by `AuditService.record`. */
  automation?: { ruleId: string; ruleName: string };
}

/**
 * Prefix of `PermissionDeniedError.digest`. Next.js replaces the message of an
 * error thrown while rendering a server component (or running a server action)
 * with a generic one in production, but preserves a `digest` the error already
 * carries and hands it to the nearest `error.tsx`. Encoding the denial in the
 * digest is what lets the org-level error boundary tell "you lack permission"
 * apart from a genuine crash and say so plainly. Presentation only: the throw
 * itself — the enforcement — is unchanged.
 */
export const PERMISSION_DENIED_DIGEST_PREFIX = "PERMISSION_DENIED";

export class PermissionDeniedError extends Error {
  readonly digest: string;

  constructor(
    public readonly permission: Permission,
    public readonly role: MembershipRole,
  ) {
    super(
      `Role ${role} does not have permission "${permission}". ` +
        `Ask an owner or administrator of this organization if you need this access.`,
    );
    this.name = "PermissionDeniedError";
    this.digest = `${PERMISSION_DENIED_DIGEST_PREFIX}|${permission}|${role}`;
  }
}

/** Reads a denial back out of an error digest (client-safe: pure string handling). Null when it is some other error. */
export function parsePermissionDeniedDigest(digest: string | undefined): { permission: string; role: string } | null {
  if (!digest?.startsWith(`${PERMISSION_DENIED_DIGEST_PREFIX}|`)) return null;
  const [, permission, role] = digest.split("|");
  if (!permission || !role) return null;
  return { permission, role };
}

export class OrganizationMismatchError extends Error {
  constructor() {
    super("Actor's organization does not match the organization for this operation.");
    this.name = "OrganizationMismatchError";
  }
}

/** Throws PermissionDeniedError if the actor's role lacks `permission`. */
export function assertPermission(actor: Actor, permission: Permission): void {
  if (!roleHasPermission(actor.role, permission)) {
    throw new PermissionDeniedError(permission, actor.role);
  }
  if (actor.grantedPermissions && !actor.grantedPermissions.has(permission)) {
    throw new PermissionDeniedError(permission, actor.role);
  }
}

/**
 * Throws if `organizationId` doesn't match the actor's own organization.
 * Call this whenever a service method takes an explicit organizationId
 * argument in addition to `actor`, so a caller can never pass an actor from
 * org A and a resource id belonging to org B.
 */
export function assertActorInOrganization(actor: Actor, organizationId: string): void {
  if (actor.organizationId !== organizationId) {
    throw new OrganizationMismatchError();
  }
}
