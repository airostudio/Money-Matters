import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, createTestUser, pgMessage, resetDatabase } from "../../helpers/db";
import { createPracticeWorld, type PracticeWorld } from "../../helpers/practice";
import { withUserScope } from "@/db/user-scope";
import {
  practiceAuditLogs,
  practiceClientGroupMembers,
  practiceClientGroups,
  practiceClientLinks,
  practiceMembers,
  practicePartners,
  practiceRoster,
  practiceTasks,
  practices,
} from "@/db/schema";
import { PracticeService } from "@/domain/practice/practice-service";
import { ClientGroupService } from "@/domain/practice/client-group-service";
import {
  AlreadyPracticeMemberError,
  CannotChangePartnerError,
  LastPartnerError,
  PracticeNotFoundError,
  PracticePermissionError,
  PracticeStaffUserNotFoundError,
  TooManyPracticesError,
} from "@/domain/practice/errors";
import { MAX_PRACTICES_PER_USER } from "@/domain/practice/types";

describe("Practices and staff — membership gate, roles and row-level security", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
  });

  describe("creating a practice and adding staff", () => {
    it("the founder becomes the first PARTNER; staff are existing users added by email", async () => {
      const mine = await PracticeService.listMine(w.partnerActor);
      expect(mine).toEqual([{ id: w.practiceId, name: "Smith & Co Accountants", role: "PARTNER" }]);
      const staff = await PracticeService.listStaff(w.partnerActor, w.practiceId);
      expect(staff.map((s) => [s.email, s.role]).sort()).toEqual(
        [[w.partner.email, "PARTNER"], [w.s1.email, "STAFF"], [w.s2.email, "STAFF"]].sort(),
      );
    });

    it("an unknown email is refused (the invitee must already be a user); the email is matched case-insensitively", async () => {
      await expect(PracticeService.addStaffByEmail(w.partnerActor, w.practiceId, "nobody@example.test", "STAFF")).rejects.toBeInstanceOf(
        PracticeStaffUserNotFoundError,
      );
      const extra = await createTestUser("Extra");
      await PracticeService.addStaffByEmail(w.partnerActor, w.practiceId, ` ${extra.email.toUpperCase()} `, "MANAGER");
      await expect(PracticeService.addStaffByEmail(w.partnerActor, w.practiceId, extra.email, "STAFF")).rejects.toBeInstanceOf(
        AlreadyPracticeMemberError,
      );
    });

    it("only a partner can add staff, change roles or rename; staff can read the directory", async () => {
      const extra = await createTestUser("Extra");
      await expect(PracticeService.addStaffByEmail(w.s1Actor, w.practiceId, extra.email, "STAFF")).rejects.toBeInstanceOf(PracticePermissionError);
      await expect(PracticeService.changeStaffRole(w.s1Actor, w.practiceId, w.s2.id, "MANAGER")).rejects.toBeInstanceOf(PracticePermissionError);
      await expect(PracticeService.rename(w.s1Actor, w.practiceId, "Mine now")).rejects.toBeInstanceOf(PracticePermissionError);
      expect((await PracticeService.listStaff(w.s1Actor, w.practiceId)).length).toBe(3);
    });

    it("a user can found at most MAX_PRACTICES_PER_USER practices", async () => {
      const u = await createTestUser("Founder");
      for (let i = 0; i < MAX_PRACTICES_PER_USER; i += 1) await PracticeService.create({ userId: u.id }, { name: `P${i}` });
      await expect(PracticeService.create({ userId: u.id }, { name: "One too many" })).rejects.toBeInstanceOf(TooManyPracticesError);
    });

    it("every mutation is written to the practice audit log", async () => {
      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.s1.id, "MANAGER");
      const actions = await withUserScope(w.partner.id, (tx) =>
        tx.select({ action: practiceAuditLogs.action }).from(practiceAuditLogs).where(eq(practiceAuditLogs.practiceId, w.practiceId)),
      );
      const names = actions.map((a) => a.action);
      expect(names).toEqual(expect.arrayContaining(["practice.created", "practice_member.added", "practice_member.role_changed", "client_link.proposed"]));
    });
  });

  describe("partners, promotion, step-down and removal", () => {
    it("promotes S1 to partner, who can then manage staff; a partner cannot demote or remove ANOTHER partner", async () => {
      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.s1.id, "PARTNER");
      const extra = await createTestUser("Extra");
      await PracticeService.addStaffByEmail(w.s1Actor, w.practiceId, extra.email, "STAFF"); // S1 is a partner now
      await expect(PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.s1.id, "STAFF")).rejects.toBeInstanceOf(CannotChangePartnerError);
      await expect(PracticeService.removeStaff(w.partnerActor, w.practiceId, w.s1.id)).rejects.toBeInstanceOf(CannotChangePartnerError);
    });

    it("a partner can step down themselves while another partner remains; the last partner cannot", async () => {
      await expect(PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.partner.id, "STAFF")).rejects.toBeInstanceOf(LastPartnerError);
      await expect(PracticeService.removeStaff(w.partnerActor, w.practiceId, w.partner.id)).rejects.toBeInstanceOf(LastPartnerError);

      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.s1.id, "PARTNER");
      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.partner.id, "STAFF");
      // The stepped-down partner has lost partner powers immediately...
      await expect(PracticeService.rename(w.partnerActor, w.practiceId, "Hijack")).rejects.toBeInstanceOf(PracticePermissionError);
      // ...and the database agrees: their partner anchor row is gone.
      const anchors = await withUserScope(w.partner.id, (tx) => tx.select().from(practicePartners));
      expect(anchors).toEqual([]);
    });

    it("a removed member loses ALL access immediately, and their assignments are cleared", async () => {
      await ClientGroupService.create(w.partnerActor, w.practiceId, "Monthly BAS");
      await ClientLinkServiceAssign();
      await PracticeService.removeStaff(w.partnerActor, w.practiceId, w.s2.id);

      await expect(PracticeService.get(w.s2Actor, w.practiceId)).rejects.toBeInstanceOf(PracticeNotFoundError);
      const seen = await withUserScope(w.s2.id, async (tx) => ({
        links: await tx.select().from(practiceClientLinks),
        groups: await tx.select().from(practiceClientGroups),
        roster: await tx.select().from(practiceRoster),
        audit: await tx.select().from(practiceAuditLogs),
      }));
      expect(seen.links).toEqual([]);
      expect(seen.groups).toEqual([]);
      expect(seen.roster).toEqual([]);
      expect(seen.audit).toEqual([]);

      const links = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceClientLinks).where(eq(practiceClientLinks.assignedUserId, w.s2.id)));
      expect(links).toEqual([]);
    });

    it("a member can leave; a removed member can be added back", async () => {
      await PracticeService.removeStaff(w.s2Actor, w.practiceId, w.s2.id);
      await expect(PracticeService.get(w.s2Actor, w.practiceId)).rejects.toBeInstanceOf(PracticeNotFoundError);
      await PracticeService.addStaffByEmail(w.partnerActor, w.practiceId, w.s2.email, "MANAGER");
      expect((await PracticeService.get(w.s2Actor, w.practiceId)).role).toBe("MANAGER");
    });

    async function ClientLinkServiceAssign() {
      const { ClientLinkService } = await import("@/domain/practice/client-link-service");
      await ClientLinkService.assign(w.partnerActor, w.practiceId, w.clients.A.organizationId, w.s2.id);
    }
  });

  describe("a user outside the practice can neither read nor write any practice row — even calling withUserScope directly", () => {
    const readers = [
      ["practices", () => withUserScope("00000000-0000-0000-0000-000000000000", (tx) => tx.select().from(practices))],
    ] as const;
    void readers;

    it("reads nothing from any practice table", async () => {
      await ClientGroupService.create(w.partnerActor, w.practiceId, "Hospitality");
      const outsiderRead = await withUserScope(w.outsider.id, async (tx) => ({
        practices: await tx.select().from(practices),
        partners: await tx.select().from(practicePartners),
        members: await tx.select().from(practiceMembers),
        roster: await tx.select().from(practiceRoster),
        audit: await tx.select().from(practiceAuditLogs),
        links: await tx.select().from(practiceClientLinks),
        groups: await tx.select().from(practiceClientGroups),
        groupMembers: await tx.select().from(practiceClientGroupMembers),
        tasks: await tx.select().from(practiceTasks),
      }));
      for (const [name, rows] of Object.entries(outsiderRead)) expect(rows, name).toEqual([]);

      // ...while the partner, in the same database, sees them.
      const partnerRead = await withUserScope(w.partner.id, async (tx) => ({
        practices: await tx.select().from(practices),
        members: await tx.select().from(practiceMembers),
        links: await tx.select().from(practiceClientLinks),
      }));
      expect(partnerRead.practices.length).toBe(1);
      expect(partnerRead.members.length).toBe(3);
      expect(partnerRead.links.length).toBe(4);
    });

    it("cannot join a practice by writing their own member/partner/roster rows", async () => {
      const attempts: Array<[string, () => Promise<unknown>]> = [
        [
          "member row for self",
          () =>
            withUserScope(w.outsider.id, (tx) =>
              tx.insert(practiceMembers).values({ practiceId: w.practiceId, userId: w.outsider.id, role: "PARTNER", status: "ACTIVE", invitedByUserId: w.outsider.id }),
            ),
        ],
        ["partner anchor for self", () => withUserScope(w.outsider.id, (tx) => tx.insert(practicePartners).values({ practiceId: w.practiceId, userId: w.outsider.id }))],
        [
          "roster row for self",
          () => withUserScope(w.outsider.id, (tx) => tx.insert(practiceRoster).values({ practiceId: w.practiceId, userId: w.outsider.id, role: "PARTNER", status: "ACTIVE" })),
        ],
        ["a task in the practice", () => withUserScope(w.outsider.id, (tx) => tx.insert(practiceTasks).values({ practiceId: w.practiceId, title: "x", createdByUserId: w.outsider.id }))],
        [
          "an audit entry",
          () =>
            withUserScope(w.outsider.id, (tx) =>
              tx.insert(practiceAuditLogs).values({ practiceId: w.practiceId, actorUserId: w.outsider.id, action: "x", entityType: "x", entityId: "x" }),
            ),
        ],
        ["a group", () => withUserScope(w.outsider.id, (tx) => tx.insert(practiceClientGroups).values({ practiceId: w.practiceId, name: "x", createdByUserId: w.outsider.id }))],
      ];
      for (const [label, attempt] of attempts) {
        expect(await pgMessage(attempt()), label).toMatch(/row-level security|violates|permission denied/i);
      }
    });

    it("cannot update or delete a practice row: renames, role changes and link edits affect zero rows", async () => {
      const renamed = await withUserScope(w.outsider.id, (tx) => tx.update(practices).set({ name: "Mine" }).where(eq(practices.id, w.practiceId)).returning());
      expect(renamed).toEqual([]);
      const promoted = await withUserScope(w.outsider.id, (tx) =>
        tx.update(practiceMembers).set({ role: "PARTNER" }).where(eq(practiceMembers.practiceId, w.practiceId)).returning(),
      );
      expect(promoted).toEqual([]);
      const reassigned = await withUserScope(w.outsider.id, (tx) =>
        tx.update(practiceClientLinks).set({ status: "ACTIVE" }).where(eq(practiceClientLinks.practiceId, w.practiceId)).returning(),
      );
      expect(reassigned).toEqual([]);
      const [still] = await withUserScope(w.partner.id, (tx) => tx.select({ name: practices.name }).from(practices));
      expect(still!.name).toBe("Smith & Co Accountants");
    });

    it("an ordinary STAFF member cannot add colleagues, promote themselves or someone else, or rewrite another's row", async () => {
      const extra = await createTestUser("Extra");
      expect(
        await pgMessage(
          withUserScope(w.s1.id, (tx) =>
            tx.insert(practiceMembers).values({ practiceId: w.practiceId, userId: extra.id, role: "STAFF", status: "ACTIVE", invitedByUserId: w.s1.id }),
          ),
        ),
      ).toMatch(/row-level security/i);
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.insert(practicePartners).values({ practiceId: w.practiceId, userId: w.s1.id })))).toMatch(
        /row-level security/i,
      );
      // Self-promotion by UPDATE: the policy's WITH CHECK only lets a member write status REMOVED to their own row.
      expect(
        await pgMessage(
          withUserScope(w.s1.id, (tx) => tx.update(practiceMembers).set({ role: "PARTNER" }).where(eq(practiceMembers.userId, w.s1.id)).returning()),
        ),
      ).toMatch(/row-level security/i);
      // Someone else's row is invisible to a non-partner, so an update touches nothing.
      const others = await withUserScope(w.s1.id, (tx) =>
        tx.update(practiceMembers).set({ status: "REMOVED" }).where(eq(practiceMembers.userId, w.s2.id)).returning(),
      );
      expect(others).toEqual([]);
    });

    it("a staff member of practice 1 sees nothing of practice 2 (two practices side by side)", async () => {
      const other = await createTestUser("OtherPartner");
      const p2 = await PracticeService.create({ userId: other.id }, { name: "Rival Practice" });
      await ClientGroupService.create({ userId: other.id }, p2.id, "Secret group");
      const seen = await withUserScope(w.partner.id, async (tx) => ({
        practices: await tx.select({ name: practices.name }).from(practices),
        groups: await tx.select({ name: practiceClientGroups.name }).from(practiceClientGroups),
      }));
      expect(seen.practices.map((p) => p.name)).toEqual(["Smith & Co Accountants"]);
      expect(seen.groups).toEqual([]);
      await expect(PracticeService.get(w.partnerActor, p2.id)).rejects.toBeInstanceOf(PracticeNotFoundError);
    });

    it("the founder cannot re-insert themselves as partner after stepping down (no self re-promotion)", async () => {
      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.s1.id, "PARTNER");
      await PracticeService.changeStaffRole(w.partnerActor, w.practiceId, w.partner.id, "STAFF");
      expect(await pgMessage(withUserScope(w.partner.id, (tx) => tx.insert(practicePartners).values({ practiceId: w.practiceId, userId: w.partner.id })))).toMatch(
        /row-level security/i,
      );
    });
  });

  it("the practice audit log is append-only for the real restricted role (UPDATE and DELETE are refused)", async () => {
    expect(
      await pgMessage(withUserScope(w.partner.id, (tx) => tx.update(practiceAuditLogs).set({ action: "tampered" }).where(eq(practiceAuditLogs.practiceId, w.practiceId)))),
    ).toMatch(/permission denied/i);
    expect(
      await pgMessage(withUserScope(w.partner.id, (tx) => tx.delete(practiceAuditLogs).where(and(eq(practiceAuditLogs.practiceId, w.practiceId))))),
    ).toMatch(/permission denied/i);
  });
});
