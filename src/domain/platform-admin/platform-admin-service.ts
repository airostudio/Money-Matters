import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { organizations, planTierEnum, users } from "@/db/schema";
import { AuditService } from "@/domain/audit/audit-service";
import {
  assertValidRole,
  changeMembershipRole,
  countActiveSeats,
  deactivateMembership,
  lockOrganization,
} from "@/domain/organizations/membership-rules";
import type { MembershipRole } from "@/domain/permissions/roles";
import { verifyPlatformAdmin } from "./identity";
import { PlatformAuditService } from "./platform-audit-service";

/**
 * Every platform-admin WRITE. Boundary (docs/security.md "Platform admin"):
 * this module touches only the non-tenant tables (users, organizations,
 * organization_memberships) and the platform audit log; the only tenant table
 * it ever writes is the affected organization's audit_logs, and only through
 * AuditService. Enforced structurally by
 * src/tests/unit/platform-admin/boundary.test.ts.
 *
 * Each method (a) re-verifies the caller is a platform admin against the
 * database, (b) applies the change through the same membership rules an
 * organization's own settings use, and (c) writes the platform audit row AND —
 * for organization-affecting changes — an entry in that organization's own
 * audit log, all in ONE transaction, so a change can never exist without its
 * audit trail.
 */

export const MAX_SEAT_LIMIT = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidSeatLimitError extends Error {
  constructor() {
    super(`Seat limit must be a whole number between 1 and ${MAX_SEAT_LIMIT}.`);
    this.name = "InvalidSeatLimitError";
  }
}

export class InvalidPlanTierError extends Error {
  constructor(tier: string) {
    super(`"${tier}" is not a valid plan tier (expected one of ${planTierEnum.enumValues.join(", ")}).`);
    this.name = "InvalidPlanTierError";
  }
}

export class SeatLimitBelowUsageError extends Error {
  constructor(
    public readonly seatsUsed: number,
    public readonly requested: number,
  ) {
    super(
      `Cannot set the seat limit to ${requested}: ${seatsUsed} seats are already in use. ` +
        `Remove members first, or choose a limit of at least ${seatsUsed}.`,
    );
    this.name = "SeatLimitBelowUsageError";
  }
}

export class CannotSuspendSelfError extends Error {
  constructor() {
    super("A platform admin cannot suspend their own account (it would lock the admin out).");
    this.name = "CannotSuspendSelfError";
  }
}

export class TargetUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User ${userId} was not found.`);
    this.name = "TargetUserNotFoundError";
  }
}

function assertUuid(id: string, what: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error(`Invalid ${what} id.`);
}

export const PlatformAdminService = {
  /** Sets an organization's seat limit and/or plan tier (a label only — no billing exists yet). */
  async setOrganizationPlan(
    adminUserId: string,
    organizationId: string,
    input: { seatLimit: number; planTier: string },
  ) {
    const admin = await verifyPlatformAdmin(adminUserId);
    assertUuid(organizationId, "organization");
    if (!Number.isInteger(input.seatLimit) || input.seatLimit < 1 || input.seatLimit > MAX_SEAT_LIMIT) {
      throw new InvalidSeatLimitError();
    }
    if (!(planTierEnum.enumValues as readonly string[]).includes(input.planTier)) {
      throw new InvalidPlanTierError(input.planTier);
    }
    const planTier = input.planTier as (typeof planTierEnum.enumValues)[number];

    return withTenant(organizationId, async (tx) => {
      const org = await lockOrganization(tx, organizationId);
      const seatsUsed = await countActiveSeats(tx, organizationId);
      if (input.seatLimit < seatsUsed) throw new SeatLimitBelowUsageError(seatsUsed, input.seatLimit);

      const before = { seatLimit: org.seatLimit, planTier: org.planTier };
      const after = { seatLimit: input.seatLimit, planTier };
      if (before.seatLimit === after.seatLimit && before.planTier === after.planTier) {
        return { changed: false as const, organization: org };
      }

      const [updated] = await tx
        .update(organizations)
        .set({ seatLimit: after.seatLimit, planTier: after.planTier, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId))
        .returning();

      const platformAuditId = await PlatformAuditService.record(tx, admin, {
        action: "organization.plan_changed",
        targetType: "Organization",
        targetId: organizationId,
        targetOrganization: organizationId,
        before,
        after,
        metadata: { organizationName: org.name, seatsUsed },
      });
      await AuditService.recordPlatformAction(tx, organizationId, {
        action: "organization.plan_changed",
        entityType: "Organization",
        entityId: organizationId,
        before,
        after,
        platformAuditId,
      });

      return { changed: true as const, organization: updated! };
    });
  },

  /** Changes a member's role, through the same rules as the organization's own settings (last-OWNER protection, valid enum). */
  async changeMemberRole(adminUserId: string, organizationId: string, membershipId: string, role: string) {
    const admin = await verifyPlatformAdmin(adminUserId);
    assertUuid(organizationId, "organization");
    assertUuid(membershipId, "membership");
    assertValidRole(role);
    const newRole: MembershipRole = role;

    return withTenant(organizationId, async (tx) => {
      const { before, after } = await changeMembershipRole(tx, organizationId, membershipId, newRole);
      if (before.role === after.role) return { changed: false as const, membership: after };

      const [target] = await tx.select({ email: users.email }).from(users).where(eq(users.id, before.userId));
      const platformAuditId = await PlatformAuditService.record(tx, admin, {
        action: "membership.role_changed",
        targetType: "OrganizationMembership",
        targetId: membershipId,
        targetOrganization: organizationId,
        before: { role: before.role },
        after: { role: after.role },
        metadata: { memberUserId: before.userId, memberEmail: target?.email },
      });
      await AuditService.recordPlatformAction(tx, organizationId, {
        action: "membership.role_changed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { role: before.role },
        after: { role: after.role },
        metadata: { memberUserId: before.userId },
        platformAuditId,
      });
      return { changed: true as const, membership: after };
    });
  },

  /** Removes a member (frees a seat); never the last OWNER. */
  async removeMember(adminUserId: string, organizationId: string, membershipId: string) {
    const admin = await verifyPlatformAdmin(adminUserId);
    assertUuid(organizationId, "organization");
    assertUuid(membershipId, "membership");

    return withTenant(organizationId, async (tx) => {
      const { before } = await deactivateMembership(tx, organizationId, membershipId);

      const [target] = await tx.select({ email: users.email }).from(users).where(eq(users.id, before.userId));
      const platformAuditId = await PlatformAuditService.record(tx, admin, {
        action: "membership.removed",
        targetType: "OrganizationMembership",
        targetId: membershipId,
        targetOrganization: organizationId,
        before: { isActive: true, role: before.role },
        after: { isActive: false },
        metadata: { memberUserId: before.userId, memberEmail: target?.email },
      });
      await AuditService.recordPlatformAction(tx, organizationId, {
        action: "membership.removed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { isActive: true, role: before.role },
        after: { isActive: false },
        metadata: { memberUserId: before.userId },
        platformAuditId,
      });
    });
  },

  /**
   * Suspends or reactivates a user. A suspended user cannot sign in, and
   * their existing sessions stop resolving on the next request
   * (getCurrentUser re-checks `disabled_at` — src/lib/session.ts). An admin
   * cannot suspend themselves. User-level, so only the platform log is
   * written (a user spans organizations; no single organization's log is the
   * right place).
   */
  async setUserSuspended(adminUserId: string, targetUserId: string, suspended: boolean) {
    const admin = await verifyPlatformAdmin(adminUserId);
    assertUuid(targetUserId, "user");
    if (suspended && targetUserId === admin.userId) throw new CannotSuspendSelfError();

    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, targetUserId))
        .for("update");
      if (!target) throw new TargetUserNotFoundError(targetUserId);

      const isSuspended = target.disabledAt !== null;
      if (isSuspended === suspended) return { changed: false as const };

      const now = new Date();
      await tx
        .update(users)
        .set({ disabledAt: suspended ? now : null, updatedAt: now })
        .where(eq(users.id, targetUserId));

      await PlatformAuditService.record(tx, admin, {
        action: suspended ? "user.suspended" : "user.reactivated",
        targetType: "User",
        targetId: targetUserId,
        before: { suspended: isSuspended },
        after: { suspended },
        metadata: { email: target.email },
      });
      return { changed: true as const };
    });
  },
};
