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

export class PermissionDeniedError extends Error {
  constructor(
    public readonly permission: Permission,
    public readonly role: MembershipRole,
  ) {
    super(`Role ${role} does not have permission "${permission}".`);
    this.name = "PermissionDeniedError";
  }
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
