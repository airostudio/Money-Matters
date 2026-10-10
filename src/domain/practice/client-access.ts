import { OrganizationService } from "@/domain/organizations/organization-service";
import type { Actor, ActorType } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { PracticeConsentService } from "./consent-service";
import { NotAClientMemberError } from "./errors";

export interface ClientAccessEntry {
  organization: { id: string; name: string; slug: string; baseCurrency: string };
  role: MembershipRole;
}

/**
 * The user's ACTIVE memberships keyed by organization — ONE query, no tenant
 * transaction. This is the single source of truth for "which clients can this
 * staff member actually read, and with what role": every per-client permission
 * check is made with the role found here (their real role in THAT client),
 * never with a practice role and never with another client's role. A practice
 * link grants nothing by itself.
 */
export async function loadClientAccessMap(userId: string): Promise<Map<string, ClientAccessEntry>> {
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

/** The staff member's real Actor in a client, or undefined when they are not a member. */
export function clientActorFor(
  userId: string,
  organizationId: string,
  access: Map<string, ClientAccessEntry>,
  type?: ActorType,
): Actor | undefined {
  const entry = access.get(organizationId);
  return entry ? { userId, organizationId, role: entry.role, type } : undefined;
}

/**
 * Builds the specific error for a staff member who is not a client's member,
 * including the client's seat position — the practical blocker is often that
 * the client is at its seat limit (docs/security.md section 13). The seat limit
 * itself is never bypassed or special-cased here.
 */
export async function explainNotAMember(clientOrganizationId: string, clientName: string): Promise<NotAClientMemberError> {
  let seats: { used: number; limit: number } | null = null;
  try {
    const usage = await OrganizationService.getSeatUsage(clientOrganizationId);
    // An ARCHIVED client is "unavailable" - the same neutral message whether or not the person was ever a member, and
    // no seat information (docs/security.md section 17).
    if (usage.archived) return new NotAClientMemberError(clientName, null, true);
    seats = { used: usage.seatsUsed, limit: usage.seatLimit };
  } catch {
    seats = null;
  }
  return new NotAClientMemberError(clientName, seats);
}

/**
 * The one gate every practice read of a client goes through, in this order:
 *  1. the staff member must be an ACTIVE member of the client organization (real role);
 *  2. the client's own consent record must be ACTIVE for this practice, checked in a fresh
 *     short tenant transaction immediately before the read — so a revocation takes effect
 *     on the very next read, and a PENDING / REVOKED / DECLINED link reads nothing.
 * Returns the Actor to use for the read. A platform admin gets nothing extra: there is
 * no admin branch here.
 */
export async function requireClientActor(
  userId: string,
  practiceId: string,
  client: { organizationId: string; name: string },
  type?: ActorType,
): Promise<Actor> {
  const membership = await OrganizationService.getMembership(userId, client.organizationId);
  if (!membership) throw await explainNotAMember(client.organizationId, client.name);
  await PracticeConsentService.assertActive(client.organizationId, practiceId);
  return { userId, organizationId: client.organizationId, role: membership.role, type };
}
