import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { organizationMemberships, organizations } from "@/db/schema";
import { OrganizationService, SeatLimitReachedError } from "@/domain/organizations/organization-service";
import { UserService } from "@/domain/auth/user-service";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";

describe("Seat limit — two people can share an account", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("a newly registered account has seat_limit 2, STANDARD tier, and the creating OWNER occupies seat 1", async () => {
    const owner = await UserService.register({ email: "owner@example.test", name: "Owner", password: "password123" });
    const org = await OrganizationService.createWithOwner(owner.id, { slug: "seat-defaults", name: "Seat Defaults" });
    expect(org.seatLimit).toBe(2);
    expect(org.planTier).toBe("STANDARD");

    const usage = await OrganizationService.getSeatUsage(org.id);
    expect(usage).toMatchObject({ seatsUsed: 1, seatLimit: 2, isFull: false });
    const [membership] = await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org.id));
    expect(membership).toMatchObject({ userId: owner.id, role: "OWNER", isActive: true });
  });

  it("allows a second member, refuses a third with a specific typed error, and the message explains what to do", async () => {
    const { owner } = await createTestOrg("seats", { seatLimit: 2 });
    const second = await createTestUser("Second");
    const third = await createTestUser("Third");

    await OrganizationService.addMemberByEmail(owner, second.email, "BOOKKEEPER");
    expect(await OrganizationService.getSeatUsage(owner.organizationId)).toMatchObject({ seatsUsed: 2, isFull: true });

    const error = await OrganizationService.addMemberByEmail(owner, third.email, "READ_ONLY").catch((e) => e);
    expect(error).toBeInstanceOf(SeatLimitReachedError);
    expect(error.seatsUsed).toBe(2);
    expect(error.seatLimit).toBe(2);
    expect(error.message).toContain("2 of 2 seats used");
    expect(error.message).toMatch(/paid add-on/i);
    expect(error.message).toMatch(/platform administrator/i);

    // Nothing was written for the refused add.
    const rows = await db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, owner.organizationId));
    expect(rows).toHaveLength(2);
  });

  it("removing a member frees a seat, and re-adding the removed user re-activates their membership", async () => {
    const { owner } = await createTestOrg("seats-free", { seatLimit: 2 });
    const second = await createTestUser("Second");
    const third = await createTestUser("Third");
    const added = await OrganizationService.addMemberByEmail(owner, second.email, "BOOKKEEPER");

    await expect(OrganizationService.addMemberByEmail(owner, third.email, "READ_ONLY")).rejects.toBeInstanceOf(SeatLimitReachedError);

    await OrganizationService.removeMember(owner, added!.id);
    expect(await OrganizationService.getSeatUsage(owner.organizationId)).toMatchObject({ seatsUsed: 1, isFull: false });

    await OrganizationService.addMemberByEmail(owner, third.email, "READ_ONLY");
    await expect(OrganizationService.addMemberByEmail(owner, second.email, "READ_ONLY")).rejects.toBeInstanceOf(SeatLimitReachedError);

    // Free the seat again and bring the original member back — same membership row, new role.
    const rows = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, third.id));
    await OrganizationService.removeMember(owner, rows[0]!.id);
    const back = await OrganizationService.addMemberByEmail(owner, second.email, "ACCOUNTANT");
    expect(back!.id).toBe(added!.id);
    expect(back!.isActive).toBe(true);
    expect(back!.role).toBe("ACCOUNTANT");
  });

  it("add-member looks the email up normalised (case/whitespace) and refuses duplicates", async () => {
    const { owner } = await createTestOrg("seats-email", { seatLimit: 5 });
    const member = await createTestUser("Member");
    await OrganizationService.addMemberByEmail(owner, `  ${member.email.toUpperCase()} `, "READ_ONLY");
    await expect(OrganizationService.addMemberByEmail(owner, member.email, "READ_ONLY")).rejects.toThrow(/already an active member/);
  });

  it("raising the seat limit takes effect immediately", async () => {
    const { owner, organizationId } = await createTestOrg("seats-raise", { seatLimit: 1 });
    const second = await createTestUser("Second");
    await expect(OrganizationService.addMemberByEmail(owner, second.email, "READ_ONLY")).rejects.toBeInstanceOf(SeatLimitReachedError);

    await db.update(organizations).set({ seatLimit: 2 }).where(eq(organizations.id, organizationId));
    await expect(OrganizationService.addMemberByEmail(owner, second.email, "READ_ONLY")).resolves.toBeTruthy();
  });

  it("concurrency: parallel adds against an org with one free seat — exactly one succeeds", async () => {
    const { owner, organizationId } = await createTestOrg("seats-race", { seatLimit: 2 });
    const candidates = [];
    for (let i = 0; i < 6; i++) candidates.push(await createTestUser(`Racer${i}`));

    const results = await Promise.allSettled(
      candidates.map((c) => OrganizationService.addMemberByEmail(owner, c.email, "READ_ONLY")),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(SeatLimitReachedError);

    const active = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, organizationId));
    expect(active.filter((m) => m.isActive)).toHaveLength(2);
  });

  it("concurrency (deterministic): add-member blocks behind a lock held on the organization row, then exactly one wins", async () => {
    const { owner, organizationId } = await createTestOrg("seats-lock", { seatLimit: 2 });
    const candidates = [];
    for (let i = 0; i < 3; i++) candidates.push(await createTestUser(`Locked${i}`));

    // Another session holds the organization row lock (as a concurrent
    // membership change would). A correct add-member must wait for it.
    const holder = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [organizationId]);

      let settled = 0;
      const attempts = candidates.map((c) =>
        OrganizationService.addMemberByEmail(owner, c.email, "READ_ONLY").then(
          (v) => {
            settled += 1;
            return { ok: true as const, v };
          },
          (e: unknown) => {
            settled += 1;
            return { ok: false as const, e };
          },
        ),
      );

      await new Promise((r) => setTimeout(r, 600));
      expect(settled, "no add-member may complete while the organization row is locked").toBe(0);

      await holder.query("COMMIT");
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.e instanceof SeatLimitReachedError)).toHaveLength(2);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("concurrency: the same user added twice in parallel yields one membership, not a unique-index crash", async () => {
    const { owner } = await createTestOrg("seats-race-same", { seatLimit: 5 });
    const member = await createTestUser("Same");
    const results = await Promise.allSettled([
      OrganizationService.addMemberByEmail(owner, member.email, "READ_ONLY"),
      OrganizationService.addMemberByEmail(owner, member.email, "READ_ONLY"),
      OrganizationService.addMemberByEmail(owner, member.email, "READ_ONLY"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/already an active member/);
    }
  });

  it("the org's own settings also protect the last OWNER (demote and remove)", async () => {
    const { owner } = await createTestOrg("seats-owner", { seatLimit: 3 });
    const [ownerMembership] = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, owner.userId));

    await expect(OrganizationService.updateMemberRole(owner, ownerMembership!.id, "READ_ONLY")).rejects.toThrow(/last OWNER/);
    await expect(OrganizationService.removeMember(owner, ownerMembership!.id)).rejects.toThrow(/last OWNER/);

    // With a second OWNER the first can step down.
    const second = await createTestUser("Second");
    const secondMembership = await OrganizationService.addMemberByEmail(owner, second.email, "OWNER");
    await OrganizationService.updateMemberRole(owner, ownerMembership!.id, "READ_ONLY");
    // ...but now the second is the last.
    const secondOwner = { ...owner, userId: second.id };
    await expect(OrganizationService.removeMember(secondOwner, secondMembership!.id)).rejects.toThrow(/last OWNER/);
  });

  it("rejects a role outside the enum", async () => {
    const { owner } = await createTestOrg("seats-role", { seatLimit: 3 });
    const member = await createTestUser("Member");
    const m = await OrganizationService.addMemberByEmail(owner, member.email, "READ_ONLY");
    await expect(OrganizationService.updateMemberRole(owner, m!.id, "GOD" as never)).rejects.toThrow(/not a valid membership role/);
    const other = await createTestUser("Other");
    await expect(OrganizationService.addMemberByEmail(owner, other.email, "GOD" as never)).rejects.toThrow(/not a valid membership role/);
  });

  it("refuses to create an organization whose slug would shadow a real route (admin, app, api, ...)", async () => {
    const user = await createTestUser("Slug");
    for (const slug of ["admin", "app", "api", "login", "register"]) {
      await expect(OrganizationService.createWithOwner(user.id, { slug, name: slug })).rejects.toThrow(/already taken/);
    }
  });
});

describe("Seat limit — migration 0035 grandfathering", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("sets seat_limit to the current active member count for orgs with more than 2 members, leaves others at 2", async () => {
    const big = await createTestOrg("grand-big");
    for (let i = 0; i < 3; i++) {
      const u = await createTestUser(`Big${i}`);
      await OrganizationService.addMemberByEmail(big.owner, u.email, "READ_ONLY");
    }
    // A removed member must not count.
    const gone = await createTestUser("Gone");
    const goneMembership = await OrganizationService.addMemberByEmail(big.owner, gone.email, "READ_ONLY");
    await OrganizationService.removeMember(big.owner, goneMembership!.id);
    const small = await createTestOrg("grand-small");
    const smallMember = await createTestUser("Small1");
    await OrganizationService.addMemberByEmail(small.owner, smallMember.email, "READ_ONLY");

    // Simulate the pre-migration state: everyone at the column default of 2.
    await db.update(organizations).set({ seatLimit: 2 });

    const migration = readFileSync(path.resolve(__dirname, "../../../../drizzle/0035_platform_admin_and_seat_limit.sql"), "utf8");
    const statement = migration
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => /UPDATE "organizations" o/.test(s));
    expect(statement, "grandfathering statement found in the migration").toBeTruthy();

    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      await admin.query(statement!.replace(/^(--.*\n)+/gm, ""));
    } finally {
      await admin.end();
    }

    const [bigOrg] = await db.select().from(organizations).where(eq(organizations.id, big.organizationId));
    const [smallOrg] = await db.select().from(organizations).where(eq(organizations.id, small.organizationId));
    expect(bigOrg!.seatLimit).toBe(4); // owner + 3 active; the removed member does not count
    expect(smallOrg!.seatLimit).toBe(2);

    // Nobody is locked out, and the grandfathered org cannot grow without the limit being raised.
    expect(await OrganizationService.getSeatUsage(big.organizationId)).toMatchObject({ seatsUsed: 4, seatLimit: 4, isFull: true });
    const extra = await createTestUser("Extra");
    await expect(OrganizationService.addMemberByEmail(big.owner, extra.email, "READ_ONLY")).rejects.toBeInstanceOf(SeatLimitReachedError);
  });
});
