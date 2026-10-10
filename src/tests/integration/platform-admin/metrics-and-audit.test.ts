import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { organizations, users } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { MetricsService } from "@/domain/platform-admin/metrics-service";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { PlatformAdminService } from "@/domain/platform-admin/platform-admin-service";
import { PlatformAuditService } from "@/domain/platform-admin/platform-audit-service";
import { ExportService } from "@/domain/platform-admin/export-service";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";

const ADMIN_EMAIL = "typhoon.tall69@gmail.com";
const originalEnv = process.env.PLATFORM_ADMIN_EMAILS;

describe("Platform metrics and directory (non-tenant tables only)", () => {
  let admin: { id: string };

  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
  });

  async function seed() {
    // org A: 2 of 2 seats (full). org B: 1 of 2. org C: grandfathered 3 of 3 + EXTENDED tier.
    const a = await createTestOrg("metrics-a", { seatLimit: 2 });
    const aMember = await createTestUser("A2");
    await OrganizationService.addMemberByEmail(a.owner, aMember.email, "BOOKKEEPER");
    const b = await createTestOrg("metrics-b", { seatLimit: 2 });
    const c = await createTestOrg("metrics-c", { seatLimit: 3 });
    for (const n of ["C2", "C3"]) {
      const u = await createTestUser(n);
      await OrganizationService.addMemberByEmail(c.owner, u.email, "READ_ONLY");
    }
    await PlatformAdminService.setOrganizationPlan(admin.id, c.organizationId, { seatLimit: 3, planTier: "EXTENDED" });
    return { a, b, c, aMember };
  }

  it("counts users, organizations, seats, tiers and suspensions correctly", async () => {
    const { aMember } = await seed();
    await PlatformAdminService.setUserSuspended(admin.id, aMember.id, true);

    // Users: admin + 3 owners + A2 + C2 + C3 = 7; 1 suspended.
    const m = await MetricsService.getPlatformMetrics(admin.id);
    expect(m.users).toEqual({ total: 7, active: 6, suspended: 1 });
    expect(m.organizations.total).toBe(3);
    // Seats used: A=2, B=1, C=3 = 6. Allowed: 2 + 2 + 3 = 7. At limit: A and C. Over: none.
    expect(m.seats).toEqual({ used: 6, allowed: 7, orgsAtLimit: 2, orgsOverLimit: 0 });
    expect(m.planTiers).toEqual([
      { planTier: "EXTENDED", organizations: 1 },
      { planTier: "STANDARD", organizations: 2 },
    ]);
    expect(m.orgsAtOrOverLimit.map((o) => o.seatsUsed).sort()).toEqual([2, 3]);
    expect(m.recentSignups).toHaveLength(7);
    expect(m.recentlySuspended.map((u) => u.id)).toEqual([aMember.id]);
    // All 7 users signed up just now: this week and this month hold all of them.
    expect(m.signupsPerWeek.reduce((n, w) => n + w.users, 0)).toBe(7);
    expect(m.signupsPerMonth.reduce((n, w) => n + w.users, 0)).toBe(7);
  });

  it("buckets signups by week and month from created_at", async () => {
    await seed();
    // Move two users 3 weeks / 3 months into the past.
    const rows = await db.select({ id: users.id }).from(users).orderBy(users.createdAt).limit(2);
    await db.execute(sql`UPDATE users SET created_at = now() - interval '3 weeks' WHERE id = ${rows[0]!.id}`);
    await db.execute(sql`UPDATE users SET created_at = now() - interval '3 months' WHERE id = ${rows[1]!.id}`);

    const m = await MetricsService.getPlatformMetrics(admin.id);
    expect(m.signupsPerWeek.length).toBeGreaterThanOrEqual(2);
    expect(m.signupsPerWeek.reduce((n, w) => n + w.users, 0)).toBe(6); // the 3-month-old signup (~13 weeks) falls outside the 12-week window
    expect(m.signupsPerMonth.reduce((n, w) => n + w.users, 0)).toBe(7);
    expect(new Set(m.signupsPerMonth.map((x) => x.period)).size).toBeGreaterThanOrEqual(2);
  });

  it("reports an over-limit (grandfathered/forced) organization separately from at-limit", async () => {
    const { a } = await seed();
    await db.update(organizations).set({ seatLimit: 1 }).where(sql`${organizations.id} = ${a.organizationId}`);
    const m = await MetricsService.getPlatformMetrics(admin.id);
    expect(m.seats.orgsOverLimit).toBe(1);
    expect(m.orgsAtOrOverLimit.find((o) => o.id === a.organizationId)).toMatchObject({ seatsUsed: 2, seatLimit: 1 });
  });

  it("lists organizations with seats, supports search and the at-limit filter, and paginates", async () => {
    const { a, c } = await seed();
    const all = await DirectoryService.listOrganizations(admin.id, {});
    expect(all.total).toBe(3);
    expect(all.rows.find((r) => r.id === a.organizationId)).toMatchObject({ seatsUsed: 2, seatLimit: 2, memberCount: 2, planTier: "STANDARD" });

    const full = await DirectoryService.listOrganizations(admin.id, { seats: "full" });
    expect(full.rows.map((r) => r.id).sort()).toEqual([a.organizationId, c.organizationId].sort());

    const search = await DirectoryService.listOrganizations(admin.id, { q: "metrics-b" });
    expect(search.total).toBe(1);

    // LIKE wildcards in the query are literal, not wildcards.
    expect((await DirectoryService.listOrganizations(admin.id, { q: "%" })).total).toBe(0);
    expect((await DirectoryService.listOrganizations(admin.id, { q: "_" })).total).toBe(0);

    const page1 = await DirectoryService.listOrganizations(admin.id, { pageSize: 2, page: 1 });
    const page2 = await DirectoryService.listOrganizations(admin.id, { pageSize: 2, page: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(new Set([...page1.rows, ...page2.rows].map((r) => r.id)).size).toBe(3);
  });

  it("lists users with their organizations and status, searchable and paginated", async () => {
    const { aMember } = await seed();
    await PlatformAdminService.setUserSuspended(admin.id, aMember.id, true);

    const found = await DirectoryService.listUsers(admin.id, { q: "a2" });
    expect(found.total).toBe(1);
    expect(found.rows[0]).toMatchObject({ id: aMember.id });
    expect(found.rows[0]!.disabledAt).toBeInstanceOf(Date);
    expect(found.rows[0]!.organizations).toHaveLength(1);
    expect(found.rows[0]!.organizations[0]!.role).toBe("BOOKKEEPER");

    const adminRow = (await DirectoryService.listUsers(admin.id, { q: ADMIN_EMAIL })).rows[0]!;
    expect(adminRow.organizations).toEqual([]); // the platform admin belongs to no organization

    const p1 = await DirectoryService.listUsers(admin.id, { pageSize: 3, page: 1 });
    const p3 = await DirectoryService.listUsers(admin.id, { pageSize: 3, page: 3 });
    expect(p1.total).toBe(7);
    expect(p1.rows).toHaveLength(3);
    expect(p3.rows).toHaveLength(1);
  });

  it("organization and user detail include members with roles and join dates", async () => {
    const { a, aMember } = await seed();
    const org = await DirectoryService.getOrganization(admin.id, a.organizationId);
    expect(org!.members).toHaveLength(2);
    expect(org!.members.map((m) => m.role).sort()).toEqual(["BOOKKEEPER", "OWNER"]);
    expect(org!.members[0]!.joinedAt).toBeInstanceOf(Date);

    const user = await DirectoryService.getUser(admin.id, aMember.id);
    expect(user!.memberships).toHaveLength(1);
    expect(user!.memberships[0]).toMatchObject({ organizationId: a.organizationId, role: "BOOKKEEPER", isActive: true });

    expect(await DirectoryService.getOrganization(admin.id, "not-a-uuid")).toBeNull();
    expect(await DirectoryService.getUser(admin.id, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("CSV export contains directory data only, neutralises formula injection, and is itself audited", async () => {
    const { aMember } = await seed();
    await db.execute(sql`UPDATE users SET name = '=HYPERLINK("http://evil","x")' WHERE id = ${aMember.id}`);

    const usersCsv = await ExportService.exportDirectory(admin.id, "users");
    expect(usersCsv.split("\r\n")[0]).toBe("id,email,name,status,created_at,organizations");
    expect(usersCsv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(usersCsv).not.toMatch(/\$2[aby]\$/); // never a password hash

    const orgsCsv = await ExportService.exportDirectory(admin.id, "organizations", { seats: "full" });
    const lines = orgsCsv.trim().split("\r\n");
    expect(lines[0]).toBe("id,name,slug,plan_tier,seats_used,seat_limit,created_at");
    expect(lines).toHaveLength(3); // header + the two full orgs

    const audit = await PlatformAuditService.list(admin.id, { action: "directory.exported" });
    expect(audit.total).toBe(2);
    expect(audit.rows.map((r) => r.targetId).sort()).toEqual(["organizations", "users"]);
  });

  it("the audit list filters by action, organization and date range, and paginates newest first", async () => {
    const { a } = await seed(); // seed() performs one plan change on org C
    await PlatformAdminService.setOrganizationPlan(admin.id, a.organizationId, { seatLimit: 4, planTier: "STANDARD" });
    await PlatformAdminService.setUserSuspended(admin.id, (await createTestUser("Z")).id, true);

    const all = await PlatformAuditService.list(admin.id, {});
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.action)[0]).toBe("user.suspended"); // newest first

    expect((await PlatformAuditService.list(admin.id, { action: "organization.plan_changed" })).total).toBe(2);
    expect((await PlatformAuditService.list(admin.id, { targetOrganization: a.organizationId })).total).toBe(1);
    expect((await PlatformAuditService.list(admin.id, { targetOrganization: "garbage" })).total).toBe(3);
    expect((await PlatformAuditService.list(admin.id, { from: new Date(Date.now() + 86_400_000) })).total).toBe(0);
    expect((await PlatformAuditService.list(admin.id, { to: new Date(Date.now() - 86_400_000) })).total).toBe(0);
    expect((await PlatformAuditService.list(admin.id, { pageSize: 2, page: 2 })).rows).toHaveLength(1);

    const forOrg = await PlatformAuditService.listForOrganization(admin.id, a.organizationId);
    expect(forOrg).toHaveLength(1);
  });
});

describe("Platform audit log is append-only for the application role", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
  });

  async function pgMessage(promise: PromiseLike<unknown>): Promise<string> {
    const error = await Promise.resolve(promise).then(
      () => null,
      (e: { message: string; cause?: { message?: string } }) => e,
    );
    expect(error, "the statement must be refused").not.toBeNull();
    return error!.cause?.message ?? error!.message;
  }

  it("mm_app can INSERT and SELECT but is denied UPDATE, DELETE and TRUNCATE", async () => {
    const admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    const target = await createTestUser("Target");
    await PlatformAdminService.setUserSuspended(admin.id, target.id, true);

    // The runtime connection really is the restricted role.
    const who = await db.execute(sql`SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS privileged`);
    expect((who.rows[0] as { u: string; privileged: boolean }).u).toBe("mm_app");
    expect((who.rows[0] as { privileged: boolean }).privileged).toBe(false);

    expect((await db.execute(sql`SELECT count(*)::int AS n FROM platform_admin_audit_logs`)).rows[0]).toEqual({ n: 1 });

    expect(await pgMessage(db.execute(sql`UPDATE platform_admin_audit_logs SET action = 'tampered'`))).toMatch(/permission denied/i);
    expect(await pgMessage(db.execute(sql`DELETE FROM platform_admin_audit_logs`))).toMatch(/permission denied/i);
    expect(await pgMessage(db.execute(sql`TRUNCATE platform_admin_audit_logs`))).toMatch(/permission denied/i);

    expect((await db.execute(sql`SELECT action FROM platform_admin_audit_logs`)).rows[0]).toEqual({ action: "user.suspended" });
  });

  it("has no organization_id column (it is a platform table, not a tenant table) and no RLS policy requirement", async () => {
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'platform_admin_audit_logs'
    `);
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name)).not.toContain("organization_id");
    const rls = await db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'platform_admin_audit_logs'`);
    expect((rls.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(false);
  });
});
