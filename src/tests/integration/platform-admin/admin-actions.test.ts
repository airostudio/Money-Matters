import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { auditLogs, organizationMemberships, organizations, platformAdminAuditLogs } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { OrganizationService, SeatLimitReachedError } from "@/domain/organizations/organization-service";
import {
  InvalidPlanTierError,
  InvalidSeatLimitError,
  PlatformAdminService,
  SeatLimitBelowUsageError,
} from "@/domain/platform-admin/platform-admin-service";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";

const ADMIN_EMAIL = "typhoon.tall69@gmail.com";
const originalEnv = process.env.PLATFORM_ADMIN_EMAILS;

async function orgAuditRows(organizationId: string) {
  return withTenant(organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, organizationId)));
}

describe("Platform admin actions", () => {
  let admin: { id: string };
  let org: Awaited<ReturnType<typeof createTestOrg>>;
  let ownerMembershipId: string;
  let member: { id: string; email: string };
  let memberMembershipId: string;

  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    org = await createTestOrg("admin-actions", { seatLimit: 2 });
    member = await createTestUser("Member");
    const added = await OrganizationService.addMemberByEmail(org.owner, member.email, "BOOKKEEPER");
    memberMembershipId = added!.id;
    const [ownerRow] = await db
      .select()
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, org.organizationId), eq(organizationMemberships.userId, org.owner.userId)));
    ownerMembershipId = ownerRow!.id;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
  });

  describe("seat limit and plan tier", () => {
    it("raising the seat limit lets a third member in immediately, and writes both audit trails", async () => {
      const third = await createTestUser("Third");
      await expect(OrganizationService.addMemberByEmail(org.owner, third.email, "READ_ONLY")).rejects.toBeInstanceOf(SeatLimitReachedError);

      const result = await PlatformAdminService.setOrganizationPlan(admin.id, org.organizationId, { seatLimit: 3, planTier: "EXTENDED" });
      expect(result.changed).toBe(true);
      expect(result.organization).toMatchObject({ seatLimit: 3, planTier: "EXTENDED" });

      await expect(OrganizationService.addMemberByEmail(org.owner, third.email, "READ_ONLY")).resolves.toBeTruthy();

      const platformRows = await db.select().from(platformAdminAuditLogs);
      expect(platformRows).toHaveLength(1);
      expect(platformRows[0]).toMatchObject({
        adminUserId: admin.id,
        adminEmail: ADMIN_EMAIL,
        action: "organization.plan_changed",
        targetType: "Organization",
        targetId: org.organizationId,
        targetOrganization: org.organizationId,
        before: { seatLimit: 2, planTier: "STANDARD" },
        after: { seatLimit: 3, planTier: "EXTENDED" },
      });

      const orgRows = (await orgAuditRows(org.organizationId)).filter((r) => r.action === "organization.plan_changed");
      expect(orgRows).toHaveLength(1);
      expect(orgRows[0]).toMatchObject({
        actorType: "SYSTEM",
        actorUserId: null,
        entityType: "Organization",
        entityId: org.organizationId,
        before: { seatLimit: 2, planTier: "STANDARD" },
        after: { seatLimit: 3, planTier: "EXTENDED" },
      });
      expect(orgRows[0]!.metadata).toMatchObject({ platformAdmin: true, platformAuditId: platformRows[0]!.id });
      // The customer-facing log never carries the admin's personal identity.
      expect(JSON.stringify(orgRows[0])).not.toContain(ADMIN_EMAIL);
    });

    it("a no-op change writes nothing", async () => {
      const result = await PlatformAdminService.setOrganizationPlan(admin.id, org.organizationId, { seatLimit: 2, planTier: "STANDARD" });
      expect(result.changed).toBe(false);
      expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
    });

    it("validates the seat limit and tier, and refuses to go below current usage", async () => {
      for (const seatLimit of [0, -1, 1.5, Number.NaN, 1001]) {
        await expect(
          PlatformAdminService.setOrganizationPlan(admin.id, org.organizationId, { seatLimit, planTier: "STANDARD" }),
        ).rejects.toBeInstanceOf(InvalidSeatLimitError);
      }
      await expect(
        PlatformAdminService.setOrganizationPlan(admin.id, org.organizationId, { seatLimit: 5, planTier: "PLATINUM" }),
      ).rejects.toBeInstanceOf(InvalidPlanTierError);
      await expect(
        PlatformAdminService.setOrganizationPlan(admin.id, org.organizationId, { seatLimit: 1, planTier: "STANDARD" }),
      ).rejects.toBeInstanceOf(SeatLimitBelowUsageError);

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(row).toMatchObject({ seatLimit: 2, planTier: "STANDARD" });
      expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
    });

    it("an unknown organization is refused", async () => {
      await expect(
        PlatformAdminService.setOrganizationPlan(admin.id, "11111111-1111-4111-8111-111111111111", { seatLimit: 3, planTier: "STANDARD" }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("role changes", () => {
    it("changes a member's role through the shared membership rules and records both trails", async () => {
      const result = await PlatformAdminService.changeMemberRole(admin.id, org.organizationId, memberMembershipId, "ACCOUNTANT");
      expect(result.changed).toBe(true);
      const [row] = await db.select().from(organizationMemberships).where(eq(organizationMemberships.id, memberMembershipId));
      expect(row!.role).toBe("ACCOUNTANT");

      const [p] = await db.select().from(platformAdminAuditLogs);
      expect(p).toMatchObject({
        action: "membership.role_changed",
        targetType: "OrganizationMembership",
        targetId: memberMembershipId,
        targetOrganization: org.organizationId,
        before: { role: "BOOKKEEPER" },
        after: { role: "ACCOUNTANT" },
      });
      expect(p!.metadata).toMatchObject({ memberEmail: member.email });

      const orgRow = (await orgAuditRows(org.organizationId)).find((r) => r.action === "membership.role_changed");
      expect(orgRow).toMatchObject({ actorType: "SYSTEM", before: { role: "BOOKKEEPER" }, after: { role: "ACCOUNTANT" } });
      expect(orgRow!.metadata).toMatchObject({ platformAdmin: true, platformAuditId: p!.id });
    });

    it("rejects a role outside the enum, and refuses to demote the last OWNER", async () => {
      await expect(
        PlatformAdminService.changeMemberRole(admin.id, org.organizationId, memberMembershipId, "SUPERUSER"),
      ).rejects.toThrow(/not a valid membership role/);
      await expect(
        PlatformAdminService.changeMemberRole(admin.id, org.organizationId, ownerMembershipId, "ADMINISTRATOR"),
      ).rejects.toThrow(/last OWNER/);

      const [owner] = await db.select().from(organizationMemberships).where(eq(organizationMemberships.id, ownerMembershipId));
      expect(owner!.role).toBe("OWNER");
      expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
    });

    it("allows demoting an OWNER once another OWNER exists", async () => {
      await PlatformAdminService.changeMemberRole(admin.id, org.organizationId, memberMembershipId, "OWNER");
      await expect(
        PlatformAdminService.changeMemberRole(admin.id, org.organizationId, ownerMembershipId, "ADMINISTRATOR"),
      ).resolves.toMatchObject({ changed: true });
    });

    it("refuses a membership that belongs to a different organization", async () => {
      const other = await createTestOrg("other-org", { seatLimit: 3 });
      await expect(
        PlatformAdminService.changeMemberRole(admin.id, other.organizationId, memberMembershipId, "ACCOUNTANT"),
      ).rejects.toThrow(/was not found/);
    });

    it("a platform admin who is not a member of the org gets no tenant access from this (they hold no membership)", async () => {
      await PlatformAdminService.changeMemberRole(admin.id, org.organizationId, memberMembershipId, "ACCOUNTANT");
      const adminMemberships = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, admin.id));
      expect(adminMemberships).toHaveLength(0);
      expect(await OrganizationService.getMembership(admin.id, org.organizationId)).toBeNull();
    });
  });

  describe("removing a member", () => {
    it("removes a member, frees the seat, and records both trails", async () => {
      await PlatformAdminService.removeMember(admin.id, org.organizationId, memberMembershipId);
      expect(await OrganizationService.getSeatUsage(org.organizationId)).toMatchObject({ seatsUsed: 1, isFull: false });
      expect(await OrganizationService.getMembership(member.id, org.organizationId)).toBeNull();

      const [p] = await db.select().from(platformAdminAuditLogs);
      expect(p).toMatchObject({ action: "membership.removed", targetId: memberMembershipId, targetOrganization: org.organizationId });
      const orgRow = (await orgAuditRows(org.organizationId)).find((r) => r.action === "membership.removed");
      expect(orgRow).toMatchObject({ actorType: "SYSTEM", entityId: memberMembershipId });
      expect(orgRow!.metadata).toMatchObject({ platformAdmin: true, platformAuditId: p!.id });

      // The freed seat is usable straight away.
      const next = await createTestUser("Next");
      await expect(OrganizationService.addMemberByEmail(org.owner, next.email, "READ_ONLY")).resolves.toBeTruthy();
    });

    it("never removes the last OWNER", async () => {
      await expect(PlatformAdminService.removeMember(admin.id, org.organizationId, ownerMembershipId)).rejects.toThrow(/last OWNER/);
      expect(await OrganizationService.getMembership(org.owner.userId, org.organizationId)).not.toBeNull();
    });

    it("cannot remove the same membership twice", async () => {
      await PlatformAdminService.removeMember(admin.id, org.organizationId, memberMembershipId);
      await expect(PlatformAdminService.removeMember(admin.id, org.organizationId, memberMembershipId)).rejects.toThrow(/was not found/);
    });
  });

  it("the audit rows never contain password hashes or other secrets", async () => {
    await PlatformAdminService.changeMemberRole(admin.id, org.organizationId, memberMembershipId, "ACCOUNTANT");
    await PlatformAdminService.setUserSuspended(admin.id, member.id, true);
    const dump = JSON.stringify(await db.select().from(platformAdminAuditLogs)) + JSON.stringify(await orgAuditRows(org.organizationId));
    expect(dump).not.toMatch(/\$2[aby]\$/); // bcrypt
    expect(dump).not.toMatch(/passwordHash|password_hash/);
  });
});
