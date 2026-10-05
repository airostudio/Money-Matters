import { roleHasPermission, type MembershipRole, type Permission } from "./roles";

export type ActorType = "HUMAN" | "AI" | "SYSTEM";

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
