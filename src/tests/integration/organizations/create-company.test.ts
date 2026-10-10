import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { accounts, auditLogs, organizationMemberships, organizations } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { AuthThrottle } from "@/domain/api/auth-throttle";
import {
  CompanyLimitReachedError,
  CreateCompanyThrottledError,
  OrganizationService,
  SlugTakenError,
  companyCreateThrottle,
} from "@/domain/organizations/organization-service";
import { OrganizationLifecycleService } from "@/domain/organizations/lifecycle-service";
import { PlatformAdminService } from "@/domain/platform-admin/platform-admin-service";
import { MAX_OWNED_ACTIVE_COMPANIES } from "@/domain/organizations/limits";
import { createCompanyAction } from "@/app/app/actions";
import { addTestMember, closeTestPools, createTestUser, resetDatabase } from "../../helpers/db";

const mockedSession = vi.mocked(getServerSession);
const signInAs = (userId: string | null) => mockedSession.mockResolvedValue(userId ? ({ user: { id: userId } } as never) : null);
const big = () => new AuthThrottle(10_000);

async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => null,
    (e: { digest?: string }) => e,
  )) as { digest?: string } | null;
  const digest = error?.digest ?? "";
  expect(digest.startsWith("NEXT_REDIRECT"), `expected a redirect, got ${digest || String(error)}`).toBe(true);
  return decodeURIComponent(digest.split(";")[2] ?? "");
}
async function ownedActive(userId: string) {
  return (await OrganizationService.listMembershipsForUser(userId)).filter((m) => m.role === "OWNER").length;
}
async function archive(userId: string, organizationId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  return OrganizationLifecycleService.archive({ userId, organizationId, role: "OWNER" }, { confirmName: org!.name, acknowledged: true, reason: "making room" });
}

describe("Create another company under the same login", () => {
  let user: { id: string; email: string };

  afterAll(closeTestPools);

  beforeEach(async () => {
    await resetDatabase();
    companyCreateThrottle.clear();
    user = await createTestUser("Founder");
  });

  afterEach(() => mockedSession.mockReset());

  it("makes the person OWNER in seat 1 of a new company with the standard defaults, starter accounts and an audit row", async () => {
    const first = await OrganizationService.createAdditionalCompany(user.id, { name: "Second Venture" }, { throttle: big() });
    expect(first).toMatchObject({ name: "Second Venture", slug: "second-venture", baseCurrency: "AUD", country: "AU", seatLimit: 2, archivedAt: null });

    const members = await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, first.id));
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: user.id, role: "OWNER", isActive: true });

    const chart = await withTenant(first.id, (tx) => tx.select().from(accounts).where(eq(accounts.organizationId, first.id)));
    expect(chart.map((a) => a.code).sort()).toEqual(["3000", "3900"]);

    const audit = await withTenant(first.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, first.id), eq(auditLogs.action, "organization.created"))));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: user.id, actorType: "HUMAN" });
    expect(audit[0]!.metadata).toMatchObject({ createdFromExistingAccount: true });
  });

  it("uses the same slug logic as registration: collisions get a suffix, reserved names are respected, an empty slug falls back", async () => {
    const a = await OrganizationService.createAdditionalCompany(user.id, { name: "Acme Pty Ltd" }, { throttle: big() });
    const b = await OrganizationService.createAdditionalCompany(user.id, { name: "Acme Pty Ltd" }, { throttle: big() });
    expect(a.slug).toBe("acme-pty-ltd");
    expect(b.slug).toMatch(/^acme-pty-ltd-[a-z0-9]{1,4}$/);

    const reserved = await OrganizationService.createAdditionalCompany(user.id, { name: "Admin" }, { throttle: big() });
    expect(reserved.slug).not.toBe("admin");
    expect(reserved.slug).toMatch(/^admin-/);
    await expect(OrganizationService.createWithOwner(user.id, { slug: "admin", name: "Admin" })).rejects.toBeInstanceOf(SlugTakenError);

    const odd = await OrganizationService.createAdditionalCompany(user.id, { name: "!!!" }, { throttle: big() });
    expect(odd.slug).toBe("business");
  });

  it("an archived company still reserves its slug, so a new company with the same name gets a different one", async () => {
    const a = await OrganizationService.createAdditionalCompany(user.id, { name: "Old Name" }, { throttle: big() });
    await archive(user.id, a.id);
    const b = await OrganizationService.createAdditionalCompany(user.id, { name: "Old Name" }, { throttle: big() });
    expect(b.slug).not.toBe(a.slug);
  });

  it("is capped at five ACTIVE owned companies; archived ones do not count; other roles do not count", async () => {
    // Being an administrator of someone else's company uses no allowance.
    const other = await createTestUser("Other");
    const othersOrg = await OrganizationService.createWithOwner(other.id, { slug: "others-co", name: "Others Co" });
    await OrganizationService.addMemberByEmail({ userId: other.id, organizationId: othersOrg.id, role: "OWNER" }, user.email, "ADMINISTRATOR");
    expect(await ownedActive(user.id)).toBe(0);

    const created = [];
    for (let i = 0; i < MAX_OWNED_ACTIVE_COMPANIES; i++) {
      created.push(await OrganizationService.createAdditionalCompany(user.id, { name: `Company ${i}` }, { throttle: big() }));
    }
    expect(await ownedActive(user.id)).toBe(MAX_OWNED_ACTIVE_COMPANIES);
    const refused = await OrganizationService.createAdditionalCompany(user.id, { name: "One Too Many" }, { throttle: big() }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(CompanyLimitReachedError);
    expect((refused as Error).message).toMatch(/5 active companies/);
    expect(await db.select().from(organizations).where(eq(organizations.name, "One Too Many"))).toHaveLength(0);

    await archive(user.id, created[0]!.id);
    expect(await ownedActive(user.id)).toBe(MAX_OWNED_ACTIVE_COMPANIES - 1);
    await expect(OrganizationService.createAdditionalCompany(user.id, { name: "Room Again" }, { throttle: big() })).resolves.toBeTruthy();
    await expect(OrganizationService.createAdditionalCompany(user.id, { name: "Full Again" }, { throttle: big() })).rejects.toBeInstanceOf(CompanyLimitReachedError);
  });

  it("restoring is held to the same cap (archive-create-restore is not a way round it) - except for the platform admin", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "typhoon.tall69@gmail.com";
    const admin = await UserService.register({ email: "typhoon.tall69@gmail.com", name: "Admin", password: "password123" });
    const first = await OrganizationService.createAdditionalCompany(user.id, { name: "Archived One" }, { throttle: big() });
    await archive(user.id, first.id);
    for (let i = 0; i < MAX_OWNED_ACTIVE_COMPANIES; i++) await OrganizationService.createAdditionalCompany(user.id, { name: `Fill ${i}` }, { throttle: big() });

    await expect(OrganizationLifecycleService.restore(user.id, first.id)).rejects.toBeInstanceOf(CompanyLimitReachedError);
    const [still] = await db.select().from(organizations).where(eq(organizations.id, first.id));
    expect(still!.archivedAt).toBeInstanceOf(Date);
    await expect(PlatformAdminService.restoreOrganization(admin.id, first.id)).resolves.toBeTruthy();
  });

  it("simultaneous creations cannot overshoot the cap (serialised on the person's own row)", async () => {
    for (let i = 0; i < MAX_OWNED_ACTIVE_COMPANIES - 2; i++) await OrganizationService.createAdditionalCompany(user.id, { name: `Pre ${i}` }, { throttle: big() });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => OrganizationService.createAdditionalCompany(user.id, { name: `Race ${i}` }, { throttle: big() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toBeInstanceOf(CompanyLimitReachedError);
    expect(await ownedActive(user.id)).toBe(MAX_OWNED_ACTIVE_COMPANIES);
  });

  it("throttles rapid repeated attempts per person (best effort, per instance)", async () => {
    const throttle = new AuthThrottle(2, 60_000);
    const now = Date.now();
    await OrganizationService.createAdditionalCompany(user.id, { name: "T1" }, { throttle, now });
    await OrganizationService.createAdditionalCompany(user.id, { name: "T2" }, { throttle, now });
    const err = await OrganizationService.createAdditionalCompany(user.id, { name: "T3" }, { throttle, now }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CreateCompanyThrottledError);
    expect(await db.select().from(organizations).where(eq(organizations.name, "T3"))).toHaveLength(0);
    // Another person is unaffected, and the window expires.
    const other = await createTestUser("Other");
    await expect(OrganizationService.createAdditionalCompany(other.id, { name: "O1" }, { throttle, now })).resolves.toBeTruthy();
    await expect(OrganizationService.createAdditionalCompany(user.id, { name: "T4" }, { throttle, now: now + 61_000 })).resolves.toBeTruthy();
  });

  it("the form action creates the company and redirects into its onboarding wizard; refusals come back to the form with the reason", async () => {
    signInAs(user.id);
    const form = (name: string) => {
      const f = new FormData();
      f.set("name", name);
      return f;
    };
    expect(await redirectTarget(createCompanyAction(form("  Wizard Co  ")))).toBe("/wizard-co/onboarding");
    const [created] = await db.select().from(organizations).where(eq(organizations.slug, "wizard-co"));
    expect(created!.name).toBe("Wizard Co");

    expect(await redirectTarget(createCompanyAction(form("   ")))).toMatch(/^\/app\/new\?error=Company name is required/);

    for (let i = 0; i < MAX_OWNED_ACTIVE_COMPANIES - 1; i++) await OrganizationService.createAdditionalCompany(user.id, { name: `Fill ${i}` }, { throttle: big() });
    expect(await redirectTarget(createCompanyAction(form("Sixth")))).toMatch(/^\/app\/new\?error=You already own 5 active companies/);

    signInAs(null);
    expect(await redirectTarget(createCompanyAction(form("Nobody")))).toBe("/login");
  });

  it("does not disturb registration's own path (a new user still gets exactly one company, no cap involved)", async () => {
    const fresh = await createTestUser("Fresh");
    const org = await OrganizationService.createWithUniqueSlug(fresh.id, { name: "Fresh Start" });
    expect(org.slug).toBe("fresh-start");
    expect(await ownedActive(fresh.id)).toBe(1);
  });

  it("an ADMINISTRATOR of an existing company can still create their own companies independently", async () => {
    const owner = await createTestUser("Owner");
    const co = await OrganizationService.createWithOwner(owner.id, { slug: "shared-co", name: "Shared Co" });
    await OrganizationService.addMemberByEmail({ userId: owner.id, organizationId: co.id, role: "OWNER" }, user.email, "ADMINISTRATOR");
    const mine = await OrganizationService.createAdditionalCompany(user.id, { name: "Mine" }, { throttle: big() });
    expect(mine.id).not.toBe(co.id);
    expect(await addTestMember({ userId: user.id, organizationId: mine.id, role: "OWNER" }, "READ_ONLY", "Invitee")).toMatchObject({ role: "READ_ONLY" });
  });
});
