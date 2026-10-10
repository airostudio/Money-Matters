import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "@/db/client";
import { auditLogs, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { UserService } from "@/domain/auth/user-service";
import { InviteService } from "@/domain/organizations/invite-service";
import * as settings from "@/app/[orgSlug]/settings/actions";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";

const mockedSession = vi.mocked(getServerSession);
const signInAs = (userId: string) => mockedSession.mockResolvedValue({ user: { id: userId } } as never);
const IDLE = { status: "idle" } as const;

async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => null,
    (e: { digest?: string }) => e,
  )) as { digest?: string } | null;
  const digest = error?.digest ?? "";
  expect(digest.startsWith("NEXT_REDIRECT"), `expected a redirect, got ${digest || String(error)}`).toBe(true);
  return decodeURIComponent(digest.split(";")[2] ?? "");
}
const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

describe("Settings actions: invite codes and the danger zone", () => {
  let org: Awaited<ReturnType<typeof createTestOrg>>;
  let slug: string;
  let name: string;

  afterAll(closeTestPools);
  afterEach(() => mockedSession.mockReset());

  beforeEach(async () => {
    await resetDatabase();
    org = await createTestOrg("settings-actions", { seatLimit: 4 });
    const [row] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
    slug = row!.slug;
    name = row!.name;
    signInAs(org.owner.userId);
  });

  describe("createInviteCodeAction", () => {
    it("returns the code in the action's RESPONSE (never a URL), once, and the list afterwards shows only the prefix", async () => {
      const state = await settings.createInviteCodeAction(slug, IDLE, form({ email: "Invitee@Example.test", role: "READ_ONLY" }));
      expect(state.status).toBe("created");
      if (state.status !== "created") throw new Error("unreachable");
      expect(state.code).toMatch(/^mmj_[a-z2-7]{32}$/);
      expect(state.email).toBe("invitee@example.test");
      const list = await InviteService.list(org.owner);
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(state.code);
      expect(list[0]!.codePrefix).toBe(state.code.slice(0, 10));
    });

    it("surfaces expected refusals as an error state (writer role without confirmation; bad input) and creates nothing", async () => {
      const unconfirmed = await settings.createInviteCodeAction(slug, IDLE, form({ email: "w@example.test", role: "BOOKKEEPER" }));
      expect(unconfirmed).toMatchObject({ status: "error" });
      expect((unconfirmed as { error: string }).error).toMatch(/Confirm that you understand/);
      expect(await settings.createInviteCodeAction(slug, IDLE, form({ email: "nope", role: "READ_ONLY" }))).toMatchObject({ status: "error" });
      expect(await InviteService.list(org.owner)).toHaveLength(0);

      const confirmed = await settings.createInviteCodeAction(slug, IDLE, form({ email: "w@example.test", role: "BOOKKEEPER", confirmWriteAccess: "true" }));
      expect(confirmed.status).toBe("created");
    });

    it("a member without membership:manage is sent to the access-denied page and nothing is created", async () => {
      const reader = await addTestMember(org.owner, "READ_ONLY", "Reader");
      signInAs(reader.userId);
      expect(await redirectTarget(settings.createInviteCodeAction(slug, IDLE, form({ email: "x@example.test", role: "READ_ONLY" })))).toMatch(/^\/[^/]+\/access-denied\?permission=membership/);
      signInAs(org.owner.userId);
      expect(await InviteService.list(org.owner)).toHaveLength(0);
    });
  });

  describe("revokeInviteAction", () => {
    it("revokes a pending invite, after which its code no longer works", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "r@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      await settings.revokeInviteAction(slug, form({ inviteId: invite.id }));
      expect((await InviteService.list(org.owner))[0]!.status).toBe("REVOKED");
      const user = await UserService.register({ email: "r@example.test", name: "R", password: "password123" });
      await expect(InviteService.redeem(user.id, code)).rejects.toThrow(/invalid or has expired/);
    });

    it("revoking something already used comes back with the reason instead of a 500", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "u@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
      const user = await UserService.register({ email: "u@example.test", name: "U", password: "password123" });
      await InviteService.redeem(user.id, code);
      expect(await redirectTarget(settings.revokeInviteAction(slug, form({ inviteId: invite.id })))).toMatch(/\/settings\?memberError=That invite has already been used/);
    });
  });

  describe("archiveCompanyAction (the Danger zone form)", () => {
    it("archives with the typed name, acknowledgement and reason, then sends the owner to the chooser", async () => {
      const target = await redirectTarget(settings.archiveCompanyAction(slug, form({ confirmName: name, acknowledge: "true", reason: "Winding the business up" })));
      expect(target).toBe("/app");
      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(row!.archivedAt).toBeInstanceOf(Date);
      expect(row!.archiveReason).toBe("Winding the business up");
      const audit = await withTenant(org.organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, org.organizationId)));
      expect(audit.filter((a) => a.action === "organization.archived")).toHaveLength(1);
    });

    it("each missing confirmation comes back to Settings with the reason, and the company stays open", async () => {
      for (const [values, message] of [
        [{ confirmName: "wrong name", acknowledge: "true", reason: "Winding the business up" }, /Type the company name exactly/],
        [{ confirmName: name, reason: "Winding the business up" }, /Tick the box/],
        [{ confirmName: name, acknowledge: "true", reason: "x" }, /Give a reason of at least 5/],
      ] as const) {
        const target = await redirectTarget(settings.archiveCompanyAction(slug, form(values)));
        expect(target).toMatch(new RegExp(`^/${slug}/settings\\?archiveError=`));
        expect(target).toMatch(message);
      }
      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(row!.archivedAt).toBeNull();
    });

    it("an ADMINISTRATOR who posts the right form is refused (OWNER only) and the company stays open", async () => {
      const adminMember = await addTestMember(org.owner, "ADMINISTRATOR", "Adm");
      signInAs(adminMember.userId);
      const target = await redirectTarget(settings.archiveCompanyAction(slug, form({ confirmName: name, acknowledge: "true", reason: "Winding the business up" })));
      expect(target).toMatch(/archiveError=Only an Owner can archive/);
      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(row!.archivedAt).toBeNull();
    });
  });

});
