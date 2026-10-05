import { and, eq, ne, sql } from "drizzle-orm";
import { organizationMemberships, organizations, membershipRoleEnum } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import type { MembershipRole } from "@/domain/permissions/roles";

/**
 * Membership rules shared by an organization's own settings
 * (OrganizationService) and the platform admin section
 * (PlatformAdminService) — one write path, so seat limits, last-OWNER
 * protection and role validation cannot drift between the two.
 *
 * Every mutating function here takes a transaction and starts by locking the
 * organization row (`SELECT … FOR UPDATE`), which serialises every membership
 * change for that organization: two simultaneous add-member calls cannot both
 * pass the seat check, and two simultaneous demotions cannot both remove the
 * last OWNER. Always lock the organization row FIRST (never a membership row
 * first) so lock order is consistent and cannot deadlock.
 *
 * A "seat" is one ACTIVE organization_memberships row. There is no pending
 * invitation concept (a member can only be attached by an existing user's
 * email), so there is nothing else to count. Removing a member (is_active =
 * false) frees the seat.
 */

export class SeatLimitReachedError extends Error {
  constructor(
    public readonly seatsUsed: number,
    public readonly seatLimit: number,
  ) {
    super(
      `This account is at its seat limit (${seatsUsed} of ${seatLimit} seats used), so another person cannot be added. ` +
        `Each account can currently be shared by up to ${seatLimit} ${seatLimit === 1 ? "person" : "people"}; ` +
        `additional seats will be available as a paid add-on. To request more seats, contact the platform administrator. ` +
        `Removing an existing member frees a seat immediately.`,
    );
    this.name = "SeatLimitReachedError";
  }
}

export class LastOwnerError extends Error {
  constructor(operation: "demote" | "remove") {
    super(
      `Cannot ${operation} the last OWNER of this organization — nobody would be left able to manage its members, ` +
        `settings and AI autonomy. Promote another member to OWNER first.`,
    );
    this.name = "LastOwnerError";
  }
}

export class InvalidRoleError extends Error {
  constructor(role: string) {
    super(`"${role}" is not a valid membership role (expected one of ${membershipRoleEnum.enumValues.join(", ")}).`);
    this.name = "InvalidRoleError";
  }
}

/**
 * Raised when an interactive grant of a role that can change financial data
 * (any write permission; OWNER and ADMINISTRATOR included) was not explicitly
 * confirmed. The settings UI asks for a tick-box; this is the server-side half
 * so the rule cannot be bypassed by crafting a request.
 */
export class WriteAccessConfirmationRequiredError extends Error {
  constructor(role: string) {
    super(
      `The ${role} role lets a person edit financial data (and, for Owner and Administrator, manage people and settings). ` +
        `Confirm that you understand this before granting it - or choose Read only if they only need to look.`,
    );
    this.name = "WriteAccessConfirmationRequiredError";
  }
}

export class AlreadyMemberError extends Error {
  constructor() {
    super("That user is already an active member of this organization.");
    this.name = "AlreadyMemberError";
  }
}

export class OrganizationRecordNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`Organization ${organizationId} was not found.`);
    this.name = "OrganizationRecordNotFoundError";
  }
}

export class MembershipNotFoundError extends Error {
  constructor(membershipId: string) {
    super(`Membership ${membershipId} was not found in this organization.`);
    this.name = "MembershipNotFoundError";
  }
}

export function assertValidRole(role: string): asserts role is MembershipRole {
  if (!(membershipRoleEnum.enumValues as readonly string[]).includes(role)) {
    throw new InvalidRoleError(role);
  }
}

/** Locks and returns the organization row — the serialisation point for every membership change. */
export async function lockOrganization(tx: TenantDb, organizationId: string) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!org) throw new OrganizationRecordNotFoundError(organizationId);
  return org;
}

export async function countActiveSeats(tx: TenantDb, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
  return row?.n ?? 0;
}

async function countOtherActiveOwners(tx: TenantDb, organizationId: string, excludingMembershipId: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.isActive, true),
        eq(organizationMemberships.role, "OWNER"),
        ne(organizationMemberships.id, excludingMembershipId),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Adds `userId` to the organization (re-activating a previously removed
 * membership rather than tripping the (org, user) unique index), refusing if
 * no seat is free. Must be called inside a transaction; locks the org row.
 */
export async function addMembership(tx: TenantDb, organizationId: string, userId: string, role: MembershipRole) {
  assertValidRole(role);
  const org = await lockOrganization(tx, organizationId);

  const [existing] = await tx
    .select()
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
  if (existing?.isActive) throw new AlreadyMemberError();

  const seatsUsed = await countActiveSeats(tx, organizationId);
  if (seatsUsed >= org.seatLimit) throw new SeatLimitReachedError(seatsUsed, org.seatLimit);

  if (existing) {
    const [reactivated] = await tx
      .update(organizationMemberships)
      .set({ isActive: true, role, updatedAt: new Date() })
      .where(eq(organizationMemberships.id, existing.id))
      .returning();
    return { membership: reactivated!, reactivated: true };
  }

  const [membership] = await tx
    .insert(organizationMemberships)
    .values({ organizationId, userId, role })
    .returning();
  return { membership: membership!, reactivated: false };
}

/** Changes an active member's role; refuses to demote the last active OWNER. */
export async function changeMembershipRole(
  tx: TenantDb,
  organizationId: string,
  membershipId: string,
  role: MembershipRole,
) {
  assertValidRole(role);
  await lockOrganization(tx, organizationId);

  const [existing] = await tx
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, membershipId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.isActive, true),
      ),
    );
  if (!existing) throw new MembershipNotFoundError(membershipId);

  if (existing.role === "OWNER" && role !== "OWNER") {
    if ((await countOtherActiveOwners(tx, organizationId, membershipId)) === 0) {
      throw new LastOwnerError("demote");
    }
  }

  const [updated] = await tx
    .update(organizationMemberships)
    .set({ role, updatedAt: new Date() })
    .where(eq(organizationMemberships.id, membershipId))
    .returning();
  return { before: existing, after: updated! };
}

/** Deactivates an active membership (freeing its seat); refuses to remove the last active OWNER. */
export async function deactivateMembership(tx: TenantDb, organizationId: string, membershipId: string) {
  await lockOrganization(tx, organizationId);

  const [existing] = await tx
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, membershipId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.isActive, true),
      ),
    );
  if (!existing) throw new MembershipNotFoundError(membershipId);

  if (existing.role === "OWNER" && (await countOtherActiveOwners(tx, organizationId, membershipId)) === 0) {
    throw new LastOwnerError("remove");
  }

  await tx
    .update(organizationMemberships)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(organizationMemberships.id, membershipId));
  return { before: existing };
}
