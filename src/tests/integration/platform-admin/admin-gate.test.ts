import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Sessions are mocked at the NextAuth boundary only; everything below it (the
// DB-backed identity lookup, the gate, the services, the actions) is real.
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { organizations, platformAdminAuditLogs, users } from "@/db/schema";
import { authOptions } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { EmailAlreadyRegisteredError, UserService } from "@/domain/auth/user-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { PlatformAdminRequiredError, isPlatformAdminEmail, verifyPlatformAdmin } from "@/domain/platform-admin/identity";
import { PlatformAdminService, CannotSuspendSelfError } from "@/domain/platform-admin/platform-admin-service";
import { MetricsService } from "@/domain/platform-admin/metrics-service";
import { DirectoryService } from "@/domain/platform-admin/directory-service";
import { PlatformAuditService } from "@/domain/platform-admin/platform-audit-service";
import { ExportService } from "@/domain/platform-admin/export-service";
import * as adminActions from "@/app/admin/actions";
import { GET as exportRoute } from "@/app/admin/export/[kind]/route";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";

const ADMIN_EMAIL = "typhoon.tall69@gmail.com";
const mockedSession = vi.mocked(getServerSession);

function signInAs(userId: string | null) {
  mockedSession.mockResolvedValue(userId ? ({ user: { id: userId } } as never) : null);
}

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
}

const originalEnv = process.env.PLATFORM_ADMIN_EMAILS;

describe("Platform admin identity gate", () => {
  let admin: { id: string; email: string };
  let ordinary: { id: string; email: string };

  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    ordinary = await UserService.register({ email: "someone@example.test", name: "Someone", password: "password123" });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
    mockedSession.mockReset();
  });

  it("admin is allowed", async () => {
    signInAs(admin.id);
    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: admin.id, email: ADMIN_EMAIL });
    await expect(verifyPlatformAdmin(admin.id)).resolves.toEqual({ userId: admin.id, email: ADMIN_EMAIL });
  });

  it("an ordinary signed-in user gets a 404 (not a 403, not a redirect)", async () => {
    signInAs(ordinary.id);
    await expectNotFound(requirePlatformAdmin());
  });

  it("a signed-out visitor gets a 404", async () => {
    signInAs(null);
    await expectNotFound(requirePlatformAdmin());
  });

  it("fails closed: with PLATFORM_ADMIN_EMAILS unset, empty or blank nobody is an admin — not even the former admin", async () => {
    signInAs(admin.id);
    for (const value of [undefined, "", "   ", " , "]) {
      if (value === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
      else process.env.PLATFORM_ADMIN_EMAILS = value;
      await expectNotFound(requirePlatformAdmin());
      await expect(verifyPlatformAdmin(admin.id)).rejects.toBeInstanceOf(PlatformAdminRequiredError);
    }
  });

  it("a configured value with different case/whitespace still matches the real account, and only that account", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "  Typhoon.Tall69@GMAIL.com , other@example.test ";
    signInAs(admin.id);
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: admin.id });
    signInAs(ordinary.id);
    await expectNotFound(requirePlatformAdmin());
  });

  it("the email is taken from the database, not the session token", async () => {
    // A token claiming to be the admin's id but with an attacker-chosen email still resolves to the stored email.
    mockedSession.mockResolvedValue({ user: { id: ordinary.id, email: ADMIN_EMAIL } } as never);
    await expectNotFound(requirePlatformAdmin());
    expect((await getCurrentUser())!.email).toBe("someone@example.test");
  });

  it("a case-variant duplicate registration cannot create a second account (application level)", async () => {
    for (const variant of ["Typhoon.Tall69@gmail.com", "TYPHOON.TALL69@GMAIL.COM", "  typhoon.tall69@gmail.com  "]) {
      await expect(
        UserService.register({ email: variant, name: "Impostor", password: "password123" }),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    }
    const all = await db.select().from(users).where(sql`lower(btrim(${users.email})) = ${ADMIN_EMAIL}`);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(admin.id);
  });

  it("simultaneous registrations of the same address yield exactly one account", async () => {
    const results = await Promise.allSettled(
      ["Race@example.test", "race@example.test", "RACE@EXAMPLE.TEST"].map((email) =>
        UserService.register({ email, name: "Racer", password: "password123" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(EmailAlreadyRegisteredError);
  });

  it("the database itself refuses a case-variant or non-normalised email, even written directly", async () => {
    async function pgMessage(promise: PromiseLike<unknown>): Promise<string> {
      const error = (await Promise.resolve(promise).then(
        () => null,
        (e: { message: string; cause?: { message?: string } }) => e,
      ))!;
      expect(error, "the write must be refused").not.toBeNull();
      return error.cause?.message ?? error.message;
    }

    expect(await pgMessage(db.insert(users).values({ email: "Typhoon.Tall69@gmail.com", name: "Impostor" }))).toMatch(
      /users_email_normalised/,
    );
    expect(await pgMessage(db.insert(users).values({ email: " pad@example.test ", name: "Pad" }))).toMatch(
      /users_email_normalised/,
    );
    expect(await pgMessage(db.insert(users).values({ email: ADMIN_EMAIL, name: "Dup" }))).toMatch(/users_email_/);

    // Re-assigning an existing row to a mixed-case address is refused too.
    expect(
      await pgMessage(db.update(users).set({ email: "Someone@Example.test" }).where(eq(users.id, ordinary.id))),
    ).toMatch(/users_email_normalised/);
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("look-alike accounts that DO register (different addresses) never pass the gate", async () => {
    for (const email of ["typhoon.tall69+admin@gmail.com", "typhoon.tall69@gmail.com.au", "typhoon.tall690@gmail.com", "typhoon_tall69@gmail.com"]) {
      const u = await UserService.register({ email, name: "Lookalike", password: "password123" });
      signInAs(u.id);
      await expectNotFound(requirePlatformAdmin());
      await expect(verifyPlatformAdmin(u.id)).rejects.toBeInstanceOf(PlatformAdminRequiredError);
      expect(isPlatformAdminEmail(u.email)).toBe(false);
    }
  });

  it("sign-in with a case-variant of the admin email resolves to the one real account", async () => {
    const found = await UserService.verifyCredentials("  TYPHOON.Tall69@Gmail.com ", "password123");
    expect(found?.id).toBe(admin.id);
  });

  it("a suspended admin is locked out of the section (404) and cannot be verified by the domain layer", async () => {
    const other = await UserService.register({ email: "second-admin@example.test", name: "Second", password: "password123" });
    process.env.PLATFORM_ADMIN_EMAILS = `${ADMIN_EMAIL},second-admin@example.test`;
    await PlatformAdminService.setUserSuspended(admin.id, other.id, true);
    signInAs(other.id);
    await expectNotFound(requirePlatformAdmin());
    await expect(verifyPlatformAdmin(other.id)).rejects.toBeInstanceOf(PlatformAdminRequiredError);
  });

  it("verifyPlatformAdmin rejects garbage ids", async () => {
    for (const id of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000", undefined, null]) {
      await expect(verifyPlatformAdmin(id as never)).rejects.toBeInstanceOf(PlatformAdminRequiredError);
    }
  });
});

describe("Every admin entry point rejects a non-admin when invoked directly", () => {
  let admin: { id: string };
  let ordinary: { id: string };
  let orgId: string;
  let membershipId: string;
  let targetUserId: string;

  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    ordinary = await UserService.register({ email: "someone@example.test", name: "Someone", password: "password123" });
    const org = await createTestOrg("gate-target", { seatLimit: 2 });
    orgId = org.organizationId;
    const target = await createTestUser("Target");
    const added = await OrganizationService.addMemberByEmail(org.owner, target.email, "BOOKKEEPER");
    membershipId = added!.id;
    targetUserId = target.id;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
    mockedSession.mockReset();
  });

  async function assertNothingChanged() {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.seatLimit).toBe(2);
    expect(org!.planTier).toBe("STANDARD");
    const [target] = await db.select().from(users).where(eq(users.id, targetUserId));
    expect(target!.disabledAt).toBeNull();
    expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(0);
  }

  it("every PlatformAdminService / read-service method refuses a non-admin (ordinary user, unknown id, signed-out)", async () => {
    for (const caller of [ordinary.id, "00000000-0000-0000-0000-000000000000", "", undefined as unknown as string]) {
      const calls: Array<() => Promise<unknown>> = [
        () => PlatformAdminService.setOrganizationPlan(caller, orgId, { seatLimit: 9, planTier: "EXTENDED" }),
        () => PlatformAdminService.changeMemberRole(caller, orgId, membershipId, "ADMINISTRATOR"),
        () => PlatformAdminService.removeMember(caller, orgId, membershipId),
        () => PlatformAdminService.setUserSuspended(caller, targetUserId, true),
        () => MetricsService.getPlatformMetrics(caller),
        () => DirectoryService.listOrganizations(caller),
        () => DirectoryService.listUsers(caller),
        () => DirectoryService.getOrganization(caller, orgId),
        () => DirectoryService.getUser(caller, targetUserId),
        () => DirectoryService.exportOrganizations(caller),
        () => DirectoryService.exportUsers(caller),
        () => PlatformAuditService.list(caller),
        () => PlatformAuditService.listForOrganization(caller, orgId),
        () => ExportService.exportDirectory(caller, "users"),
      ];
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(PlatformAdminRequiredError);
    }
    await assertNothingChanged();
  });

  it("every exported server action 404s for an ordinary user and for a signed-out visitor, and changes nothing", async () => {
    const actionNames = Object.keys(adminActions);
    expect(actionNames.sort()).toEqual(
      [
        "changeMemberRoleAction",
        "reactivateUserAction",
        "removeMemberAction",
        "suspendUserAction",
        "updateOrganizationPlanAction",
      ].sort(),
    );

    const form = new FormData();
    form.set("organizationId", orgId);
    form.set("membershipId", membershipId);
    form.set("userId", targetUserId);
    form.set("seatLimit", "9");
    form.set("planTier", "EXTENDED");
    form.set("role", "ADMINISTRATOR");

    for (const session of [ordinary.id, null]) {
      signInAs(session);
      for (const [name, action] of Object.entries(adminActions)) {
        await expect(action(form), name).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
      }
    }
    await assertNothingChanged();
  });

  it("the CSV export route 404s for non-admins", async () => {
    for (const session of [ordinary.id, null]) {
      signInAs(session);
      const request = { nextUrl: new URL("http://localhost/admin/export/users") } as never;
      await expect(exportRoute(request, { params: { kind: "users" } })).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    }
  });

  it("a server action invoked as the admin works end to end: change applied, redirected with a success notice, both audit trails written", async () => {
    signInAs(admin.id);
    const form = new FormData();
    form.set("organizationId", orgId);
    form.set("seatLimit", "5");
    form.set("planTier", "EXTENDED");
    form.set("returnTo", `/admin/organizations/${orgId}`);

    const error = await adminActions.updateOrganizationPlanAction(form).catch((e) => e);
    expect(String(error.digest)).toContain("NEXT_REDIRECT");
    expect(String(error.digest)).toContain(`/admin/organizations/${orgId}?ok=`);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org).toMatchObject({ seatLimit: 5, planTier: "EXTENDED" });
    expect(await db.select().from(platformAdminAuditLogs)).toHaveLength(1);
  });

  it("a refused admin action redirects back with the reason instead of throwing a 500", async () => {
    signInAs(admin.id);
    const form = new FormData();
    form.set("userId", admin.id);
    const error = await adminActions.suspendUserAction(form).catch((e) => e);
    expect(String(error.digest)).toContain("NEXT_REDIRECT");
    expect(decodeURIComponent(String(error.digest))).toContain("cannot suspend their own account");
  });

  it("an open redirect via returnTo is ignored", async () => {
    signInAs(admin.id);
    const form = new FormData();
    form.set("userId", admin.id);
    form.set("returnTo", "https://evil.example/phish");
    const error = await adminActions.suspendUserAction(form).catch((e) => e);
    expect(String(error.digest)).toContain(`/admin/users/${admin.id}?error=`);
    expect(String(error.digest)).not.toContain("evil.example");
  });
});

describe("Suspended users", () => {
  let admin: { id: string };
  let victim: { id: string; email: string };

  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    admin = await UserService.register({ email: ADMIN_EMAIL, name: "Admin", password: "password123" });
    victim = await UserService.register({ email: "victim@example.test", name: "Victim", password: "password123" });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = originalEnv;
    mockedSession.mockReset();
  });

  it("cannot sign in once suspended (through NextAuth's own authorize), and can again once reactivated", async () => {
    const provider = authOptions.providers[0] as unknown as {
      options: { authorize: (c: Record<string, string>) => Promise<{ id: string } | null> };
    };
    const creds = { email: "victim@example.test", password: "password123" };
    expect((await provider.options.authorize(creds))?.id).toBe(victim.id);

    await PlatformAdminService.setUserSuspended(admin.id, victim.id, true);
    expect(await provider.options.authorize(creds)).toBeNull();
    // Indistinguishable from a wrong password.
    expect(await provider.options.authorize({ ...creds, password: "wrong-password" })).toBeNull();

    await PlatformAdminService.setUserSuspended(admin.id, victim.id, false);
    expect((await provider.options.authorize(creds))?.id).toBe(victim.id);
  });

  it("an already-issued session stops resolving on the very next request", async () => {
    const org = await createTestOrg("suspend-session");
    // victim is a member so org-scoped resolution would otherwise succeed
    await OrganizationService.addMemberByEmail(org.owner, victim.email, "BOOKKEEPER");
    signInAs(victim.id); // the JWT is still perfectly valid

    expect(await getCurrentUser()).toMatchObject({ id: victim.id });
    const { getActorForOrganization } = await import("@/lib/session");
    expect(await getActorForOrganization(org.organizationId)).toMatchObject({ userId: victim.id });

    await PlatformAdminService.setUserSuspended(admin.id, victim.id, true);

    expect(await getCurrentUser()).toBeNull();
    expect(await getActorForOrganization(org.organizationId)).toBeNull();

    await PlatformAdminService.setUserSuspended(admin.id, victim.id, false);
    expect(await getCurrentUser()).toMatchObject({ id: victim.id });
  });

  it("an admin cannot suspend themselves (server-side), but can suspend others and reactivate them", async () => {
    await expect(PlatformAdminService.setUserSuspended(admin.id, admin.id, true)).rejects.toBeInstanceOf(CannotSuspendSelfError);
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row!.disabledAt).toBeNull();

    expect(await PlatformAdminService.setUserSuspended(admin.id, victim.id, true)).toEqual({ changed: true });
    expect(await PlatformAdminService.setUserSuspended(admin.id, victim.id, true)).toEqual({ changed: false });
    expect(await PlatformAdminService.setUserSuspended(admin.id, victim.id, false)).toEqual({ changed: true });
  });

  it("writes a platform audit row for each suspend/reactivate, with the admin's email snapshot", async () => {
    await PlatformAdminService.setUserSuspended(admin.id, victim.id, true);
    await PlatformAdminService.setUserSuspended(admin.id, victim.id, false);
    const rows = await db.select().from(platformAdminAuditLogs).orderBy(platformAdminAuditLogs.createdAt);
    expect(rows.map((r) => r.action)).toEqual(["user.suspended", "user.reactivated"]);
    expect(rows[0]).toMatchObject({ adminUserId: admin.id, adminEmail: ADMIN_EMAIL, targetType: "User", targetId: victim.id });
  });
});
