import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-for": "203.0.113.77" }) }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { organizationMemberships, organizations, users } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { InviteService, inviteRedeemThrottle } from "@/domain/organizations/invite-service";
import { INVITE_REDEEM_THROTTLE_MAX_FAILURES } from "@/domain/organizations/limits";
import { registerAction } from "@/app/(auth)/register/actions";
import { joinCompanyAction } from "@/app/app/actions";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";

const mockedSession = vi.mocked(getServerSession);
const signInAs = (userId: string | null) => mockedSession.mockResolvedValue(userId ? ({ user: { id: userId } } as never) : null);

async function redirectUrl(promise: Promise<unknown>): Promise<URL> {
  const error = (await promise.then(
    () => null,
    (e: { digest?: string }) => e,
  )) as { digest?: string } | null;
  const digest = error?.digest ?? "";
  expect(digest.startsWith("NEXT_REDIRECT"), `expected a redirect, got ${digest || String(error)}`).toBe(true);
  return new URL(digest.split(";")[2] ?? "", "http://localhost");
}

function registrationForm(values: Partial<Record<"name" | "email" | "password" | "organizationName" | "inviteCode", string>>) {
  const f = new FormData();
  f.set("name", values.name ?? "New Person");
  f.set("email", values.email ?? "new.person@example.test");
  f.set("password", values.password ?? "password123");
  if (values.organizationName !== undefined) f.set("organizationName", values.organizationName);
  if (values.inviteCode !== undefined) f.set("inviteCode", values.inviteCode);
  return f;
}
async function membershipsOf(email: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) return null;
  return db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, u.id));
}

describe("Joining a company: registration with an invite code, and the chooser's Join form", () => {
  let org: Awaited<ReturnType<typeof createTestOrg>>;

  afterAll(closeTestPools);

  beforeEach(async () => {
    await resetDatabase();
    inviteRedeemThrottle.clear();
    org = await createTestOrg("join-target", { seatLimit: 3 });
  });

  afterEach(() => mockedSession.mockReset());

  describe("registration with a code", () => {
    it("a brand-new user who redeems a valid code joins the company as the invited role and does NOT also get a personal company", async () => {
      const { code } = await InviteService.create(org.owner, { email: "new.person@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "", inviteCode: code })));

      const [target] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("registered")).toBe("1");
      expect(url.searchParams.get("next")).toBe(`/${target!.slug}`);
      expect(url.searchParams.get("notice")).toBeNull();

      const memberships = (await membershipsOf("new.person@example.test"))!;
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ organizationId: org.organizationId, role: "READ_ONLY", isActive: true });
      expect(await db.select().from(organizations)).toHaveLength(1); // no personal company was created
    });

    it("a business name is still accepted alongside a valid code; the code wins and no personal company is made", async () => {
      const { code } = await InviteService.create(org.owner, { email: "new.person@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      await redirectUrl(registerAction(registrationForm({ organizationName: "My Own Thing", inviteCode: code })));
      expect(await db.select().from(organizations)).toHaveLength(1);
    });

    it("an invalid code falls back to normal registration with a clear message: the account and own company are still created", async () => {
      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "Fallback Co", inviteCode: "mmj_" + "a".repeat(32) })));
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe("/fallback-co/onboarding");
      expect(url.searchParams.get("notice")).toMatch(/invite code could not be used: That invite code is invalid or has expired/);
      expect(url.searchParams.get("notice")).toMatch(/own company was set up instead/);

      const memberships = (await membershipsOf("new.person@example.test"))!;
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.role).toBe("OWNER");
    });

    it("an invalid code with no business name still creates the account (never lost over a bad code) and says what to do next", async () => {
      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "", inviteCode: "garbage" })));
      expect(url.searchParams.get("next")).toBe("/app");
      expect(url.searchParams.get("notice")).toMatch(/invite code could not be used/);
      expect(await membershipsOf("new.person@example.test")).toEqual([]);
    });

    it("a code for a DIFFERENT email is refused with the same generic message, and stays valid for its real invitee", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "someone.else@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "Own Co", inviteCode: code })));
      expect(url.searchParams.get("notice")).toMatch(/invalid or has expired/);
      const invites = await InviteService.list(org.owner);
      expect(invites.find((i) => i.id === invite.id)!.status).toBe("PENDING");
    });

    it("a full company reports the specific seat message but still creates the account and the fallback company", async () => {
      await addTestMember(org.owner, "READ_ONLY", "Filler");
      await addTestMember(org.owner, "READ_ONLY", "Filler2"); // 3 of 3
      // create() allows an invite for a full company: the seat is checked at redemption.
      const { code } = await InviteService.create(org.owner, { email: "new.person@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "Plan B Ltd", inviteCode: code })));
      expect(url.searchParams.get("notice")).toMatch(/seat limit \(3 of 3 seats used\)/);
      expect(url.searchParams.get("next")).toBe("/plan-b-ltd/onboarding");
    });

    it("without a code, registration is exactly as before: needs a business name, creates the company, goes to onboarding", async () => {
      const missing = await redirectUrl(registerAction(registrationForm({ organizationName: "" })));
      expect(missing.pathname).toBe("/register");
      expect(missing.searchParams.get("error")).toBe("Business name is required");

      const url = await redirectUrl(registerAction(registrationForm({ organizationName: "Plain Co" })));
      expect(url.searchParams.get("next")).toBe("/plain-co/onboarding");
      expect(url.searchParams.get("notice")).toBeNull();

      const dup = await redirectUrl(registerAction(registrationForm({ organizationName: "Plain Co" })));
      expect(dup.pathname).toBe("/register"); // email already registered
      expect(dup.searchParams.get("error")).toMatch(/already/i);
    });

    it("slug collisions at registration are still handled (now with repeated retries)", async () => {
      await redirectUrl(registerAction(registrationForm({ email: "a@example.test", organizationName: "Same Name" })));
      const second = await redirectUrl(registerAction(registrationForm({ email: "b@example.test", organizationName: "Same Name" })));
      expect(second.searchParams.get("next")).toMatch(/^\/same-name-[a-z0-9]+\/onboarding$/);
    });
  });

  describe("the chooser's Join a company form", () => {
    it("joins the signed-in user to the company and sends them into it", async () => {
      const { code } = await InviteService.create(org.owner, { email: "joiner@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const joiner = await UserService.register({ email: "joiner@example.test", name: "Joiner", password: "password123" });
      signInAs(joiner.id);
      const f = new FormData();
      f.set("code", code);
      const url = await redirectUrl(joinCompanyAction(f));
      const [target] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(url.pathname).toBe(`/${target!.slug}`);
      expect((await OrganizationService.listMembershipsForUser(joiner.id)).map((m) => [m.organization.id, m.role])).toEqual([[org.organizationId, "READ_ONLY"]]);
    });

    it("a wrong code, a wrong-email account and an empty field all return to the chooser with a message that reveals nothing", async () => {
      const { code } = await InviteService.create(org.owner, { email: "real@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const stranger = await UserService.register({ email: "stranger@example.test", name: "Stranger", password: "password123" });
      signInAs(stranger.id);
      const messages = new Set<string>();
      for (const attempt of [code, "mmj_" + "z".repeat(32), "nonsense"]) {
        const f = new FormData();
        f.set("code", attempt);
        const url = await redirectUrl(joinCompanyAction(f));
        expect(url.pathname).toBe("/app");
        messages.add(url.searchParams.get("joinError")!);
      }
      expect([...messages]).toEqual(["That invite code is invalid or has expired. Check it with the person who sent it, or ask them for a new one."]);

      const empty = new FormData();
      empty.set("code", "   ");
      expect((await redirectUrl(joinCompanyAction(empty))).searchParams.get("joinError")).toMatch(/Enter the invite code/);
      expect(await membershipsOf("stranger@example.test")).toEqual([]);
    });

    it("repeated wrong codes lock the person out (and their address) before even a correct one is checked", async () => {
      const { code } = await InviteService.create(org.owner, { email: "locked@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const user = await UserService.register({ email: "locked@example.test", name: "Locked", password: "password123" });
      signInAs(user.id);
      for (let i = 0; i < INVITE_REDEEM_THROTTLE_MAX_FAILURES; i++) {
        const f = new FormData();
        f.set("code", "mmj_" + String.fromCharCode(97 + i).repeat(32));
        await redirectUrl(joinCompanyAction(f));
      }
      const f = new FormData();
      f.set("code", code);
      const url = await redirectUrl(joinCompanyAction(f));
      expect(url.searchParams.get("joinError")).toMatch(/Too many incorrect invite codes/);
      expect(await membershipsOf("locked@example.test")).toEqual([]);
    });

    it("a signed-out visitor is sent to sign in and nothing is redeemed", async () => {
      signInAs(null);
      const f = new FormData();
      f.set("code", "mmj_" + "a".repeat(32));
      expect((await redirectUrl(joinCompanyAction(f))).pathname).toBe("/login");
    });
  });

  it("the existing add-registered-user-by-email flow is unchanged next to invite codes", async () => {
    const member = await UserService.register({ email: "direct@example.test", name: "Direct", password: "password123" });
    await OrganizationService.addMemberByEmail(org.owner, member.email, "READ_ONLY");
    expect((await OrganizationService.listMembershipsForUser(member.id)).map((m) => m.organization.id)).toEqual([org.organizationId]);
  });
});
