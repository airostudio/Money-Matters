import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor, ActorType } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { NotAMemberOfEntityError } from "./errors";

/** The acting user at GROUP level (a group belongs to a user, not to an organization). */
export interface GroupActor {
  userId: string;
  type?: ActorType;
}

export interface EntityAccess {
  organization: { id: string; name: string; slug: string; baseCurrency: string };
  role: MembershipRole;
}

/**
 * The user's ACTIVE memberships keyed by organization — ONE query, no tenant
 * transaction. This is the single source of truth for "which entities can this
 * user touch, and with what role": every per-entity permission check in
 * consolidation is made with the role found here (the user's real role in THAT
 * entity), never with a role from some other entity or from the group.
 */
export async function loadEntityAccessMap(userId: string): Promise<Map<string, EntityAccess>> {
  const rows = await OrganizationService.listMembershipsForUser(userId);
  return new Map(
    rows.map((r) => [
      r.organization.id,
      {
        organization: {
          id: r.organization.id,
          name: r.organization.name,
          slug: r.organization.slug,
          baseCurrency: r.organization.baseCurrency,
        },
        role: r.role,
      },
    ]),
  );
}

/** The user's real Actor in an entity, or NotAMemberOfEntityError (identical for "no such org" and "not yours"). */
export function entityActorFor(
  actor: GroupActor,
  organizationId: string,
  access: Map<string, EntityAccess>,
): { actor: Actor; access: EntityAccess } {
  const entry = access.get(organizationId);
  if (!entry) throw new NotAMemberOfEntityError();
  return {
    access: entry,
    actor: { userId: actor.userId, organizationId, role: entry.role, type: actor.type },
  };
}
