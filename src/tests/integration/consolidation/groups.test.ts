import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";
import { createConsolidationWorld, createFullGroup, type ConsolidationWorld } from "../../helpers/consolidation";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { withUserScope } from "@/db/user-scope";
import {
  accounts,
  auditLogs,
  entityGroupAdjustmentLines,
  entityGroupAdjustments,
  entityGroupAuditLogs,
  entityGroupIntercompanyAccounts,
  entityGroupAccountMappings,
  entityGroupAccounts,
  entityGroupMembers,
  entityGroups,
} from "@/db/schema";
import { GroupService } from "@/domain/consolidation/group-service";
import { AdjustmentService } from "@/domain/consolidation/adjustment-service";
import {
  EntityAlreadyInGroupError,
  GroupAccountInUseError,
  GroupFullError,
  GroupNameTakenError,
  GroupNotFoundError,
  IntercompanyDesignationError,
  InvalidAdjustmentError,
  InvalidMappingError,
  NotAMemberOfEntityError,
  ParentAlreadyExistsError,
  AdjustmentAlreadyReversedError,
} from "@/domain/consolidation/errors";
import { MAX_ENTITIES_PER_GROUP } from "@/domain/consolidation/types";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { OrganizationService } from "@/domain/organizations/organization-service";

describe("Entity groups — ownership, per-entity permission rules, row-level security", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let world: ConsolidationWorld;

  beforeEach(async () => {
    await resetDatabase();
    world = await createConsolidationWorld({ seedLedgers: false });
  });

  describe("adding an entity requires consolidation:manage IN THAT ENTITY", () => {
    it("OWNER in A and ACCOUNTANT in B may add; READ_ONLY in C may not; a non-member of D may not", async () => {
      await world.setUserRole("B", "ACCOUNTANT");
      await world.setUserRole("C", "READ_ONLY");
      await world.removeUser("D");

      const group = await GroupService.create(world.groupActor, { name: "Holdings" });
      await GroupService.addEntity(world.groupActor, group.id, world.entities.A.organizationId);
      await GroupService.addEntity(world.groupActor, group.id, world.entities.B.organizationId);

      await expect(GroupService.addEntity(world.groupActor, group.id, world.entities.C.organizationId)).rejects.toThrow(
        PermissionDeniedError,
      );
      await expect(GroupService.addEntity(world.groupActor, group.id, world.entities.D.organizationId)).rejects.toThrow(
        NotAMemberOfEntityError,
      );

      const detail = await GroupService.get(world.groupActor, group.id);
      expect(detail.members.map((m) => m.organizationId).sort()).toEqual(
        [world.entities.A.organizationId, world.entities.B.organizationId].sort(),
      );
    });

    it("every role without consolidation:manage is refused (checked with the user's real role in the entity)", async () => {
      const group = await GroupService.create(world.groupActor, { name: "Roles" });
      for (const role of ["BOOKKEEPER", "MANAGER", "READ_ONLY", "EMPLOYEE", "ACCOUNTS_PAYABLE"] as const) {
        await world.setUserRole("C", role);
        await expect(GroupService.addEntity(world.groupActor, group.id, world.entities.C.organizationId), role).rejects.toThrow(
          PermissionDeniedError,
        );
      }
      await world.setUserRole("C", "ADMINISTRATOR");
      await GroupService.addEntity(world.groupActor, group.id, world.entities.C.organizationId);
    });

    it("a user cannot add an organization they are not a member of, and the refusal does not distinguish 'does not exist'", async () => {
      const group = await GroupService.create(world.groupActor, { name: "Probe" });
      const stranger = await createTestOrg("stranger");
      await expect(GroupService.addEntity(world.groupActor, group.id, stranger.organizationId)).rejects.toThrow(NotAMemberOfEntityError);
      await expect(
        GroupService.addEntity(world.groupActor, group.id, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(NotAMemberOfEntityError);
    });

    it("the DATABASE itself refuses a member row for an organization the owner is not in, even bypassing the service", async () => {
      const group = await GroupService.create(world.groupActor, { name: "Direct" });
      await world.removeUser("D");
      await expect(
        withUserScope(world.user.id, (tx) =>
          tx.insert(entityGroupMembers).values({
            groupId: group.id,
            ownerUserId: world.user.id,
            memberOrganizationId: world.entities.D.organizationId,
            addedByUserId: world.user.id,
          }),
        ),
      ).rejects.toThrow();
      // ...whereas an organization they ARE in is accepted at the same level.
      await withUserScope(world.user.id, (tx) =>
        tx.insert(entityGroupMembers).values({
          groupId: group.id,
          ownerUserId: world.user.id,
          memberOrganizationId: world.entities.A.organizationId,
          addedByUserId: world.user.id,
        }),
      );
    });

    it("the first entity becomes the PARENT and seeds the group chart; a second parent is refused; duplicates are refused", async () => {
      const group = await GroupService.create(world.groupActor, { name: "Parents" });
      await GroupService.addEntity(world.groupActor, group.id, world.entities.A.organizationId);
      await GroupService.addEntity(world.groupActor, group.id, world.entities.B.organizationId);
      const detail = await GroupService.get(world.groupActor, group.id);
      const roleOf = (key: "A" | "B") => detail.members.find((m) => m.organizationId === world.entities[key].organizationId)!.role;
      expect(roleOf("A")).toBe("PARENT");
      expect(roleOf("B")).toBe("SUBSIDIARY");
      // Seeded from A's chart (7 sample accounts + the 2 starter system accounts).
      expect(detail.config.groupAccounts.map((g) => g.code)).toEqual(expect.arrayContaining(["1000", "1500", "2500", "4000", "6000", "3000", "3900"]));

      await expect(GroupService.addEntity(world.groupActor, group.id, world.entities.B.organizationId)).rejects.toThrow(EntityAlreadyInGroupError);
      await expect(
        GroupService.addEntity(world.groupActor, group.id, world.entities.C.organizationId, "PARENT"),
      ).rejects.toThrow(ParentAlreadyExistsError);
    });

    it("an entity's own audit log gets an informational note carrying only the opaque group id — never the group name", async () => {
      const group = await GroupService.create(world.groupActor, { name: "Secret Holdings Name" });
      await GroupService.addEntity(world.groupActor, group.id, world.entities.A.organizationId);
      await GroupService.addEntity(world.groupActor, group.id, world.entities.B.organizationId);

      const logs = await withTenant(world.entities.B.organizationId, (tx) => tx.select().from(auditLogs));
      const note = logs.find((l) => l.action === "consolidation.entity_added_to_group");
      expect(note).toBeDefined();
      expect(note!.actorUserId).toBe(world.user.id);
      expect(note!.metadata).toEqual({ groupId: group.id });
      expect(JSON.stringify(note)).not.toContain("Secret Holdings Name");
      expect(JSON.stringify(note)).not.toContain(world.entities.A.organizationId);

      await GroupService.removeEntity(world.groupActor, group.id, world.entities.B.organizationId);
      const after = await withTenant(world.entities.B.organizationId, (tx) => tx.select().from(auditLogs));
      expect(after.some((l) => l.action === "consolidation.entity_removed_from_group")).toBe(true);
    });
  });

  describe("group size cap", () => {
    it(`holds at most ${MAX_ENTITIES_PER_GROUP} entities`, async () => {
      const group = await GroupService.create(world.groupActor, { name: "Big" });
      await GroupService.addEntity(world.groupActor, group.id, world.entities.A.organizationId);
      const extras: string[] = [];
      for (let i = 0; i < MAX_ENTITIES_PER_GROUP - 1; i++) {
        const org = await createTestOrg(`cap-${i}`);
        await OrganizationService.addMemberByEmail(org.owner, world.user.email, "OWNER");
        extras.push(org.organizationId);
        await GroupService.addEntity(world.groupActor, group.id, org.organizationId);
      }
      const detail = await GroupService.get(world.groupActor, group.id);
      expect(detail.members).toHaveLength(MAX_ENTITIES_PER_GROUP);

      await expect(GroupService.addEntity(world.groupActor, group.id, world.entities.B.organizationId)).rejects.toThrow(GroupFullError);
    });
  });

  describe("a user cannot read or modify another user's groups", () => {
    it("is invisible and immutable through every service method", async () => {
      const group = await createFullGroup(world);
      const intruder = await createTestUser("Intruder");
      const them = { userId: intruder.id };

      expect(await GroupService.list(them)).toEqual([]);
      await expect(GroupService.get(them, group.id)).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.update(them, group.id, { name: "Mine now" })).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.archive(them, group.id)).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.removeEntity(them, group.id, world.entities.A.organizationId)).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.setEntityIncluded(them, group.id, world.entities.A.organizationId, false)).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.addGroupAccount(them, group.id, { type: "ASSET", code: "1", name: "x" })).rejects.toThrow(GroupNotFoundError);
      await expect(
        AdjustmentService.create(them, group.id, {
          kind: "ADJUSTMENT",
          effectiveDate: new Date(),
          description: "x",
          reason: "x",
          lines: [],
        }),
      ).rejects.toThrow(InvalidAdjustmentError); // validation first; the next line proves the group itself is unreachable
      await expect(AdjustmentService.list(them, group.id)).rejects.toThrow(GroupNotFoundError);

      // The owner's group is untouched.
      const detail = await GroupService.get(world.groupActor, group.id);
      expect(detail.group.name).toBe("Test Group");
      expect(detail.members).toHaveLength(4);
    });

    it("row-level security hides and protects every group table at the database level", async () => {
      const group = await createFullGroup(world);
      await GroupService.addGroupAccount(world.groupActor, group.id, { type: "ASSET", code: "9999", name: "Extra" });
      const intruder = await createTestUser("Intruder");

      // No scope at all: nothing visible in any group table.
      expect(await db.select().from(entityGroups)).toHaveLength(0);
      expect(await db.select().from(entityGroupMembers)).toHaveLength(0);
      expect(await db.select().from(entityGroupAccounts)).toHaveLength(0);
      expect(await db.select().from(entityGroupAuditLogs)).toHaveLength(0);

      // Another user's scope: still nothing.
      for (const table of [entityGroups, entityGroupMembers, entityGroupAccounts, entityGroupAuditLogs, entityGroupAccountMappings, entityGroupIntercompanyAccounts, entityGroupAdjustments, entityGroupAdjustmentLines]) {
        expect(await withUserScope(intruder.id, (tx) => tx.select().from(table))).toHaveLength(0);
      }
      // The owner's scope sees their rows.
      expect((await withUserScope(world.user.id, (tx) => tx.select().from(entityGroups))).length).toBe(1);

      // Writes into someone else's group are refused (insert) or silently match nothing (update/delete).
      await expect(
        withUserScope(intruder.id, (tx) =>
          tx.insert(entityGroupAccounts).values({ groupId: group.id, ownerUserId: world.user.id, type: "ASSET", code: "1", name: "x" }),
        ),
      ).rejects.toThrow();
      await expect(
        withUserScope(intruder.id, (tx) =>
          tx.insert(entityGroupAccounts).values({ groupId: group.id, ownerUserId: intruder.id, type: "ASSET", code: "1", name: "x" }),
        ),
      ).rejects.toThrow(); // composite FK (group, owner) -> the group's real owner
      const updated = await withUserScope(intruder.id, (tx) =>
        tx.update(entityGroups).set({ name: "hijacked" }).where(eq(entityGroups.id, group.id)).returning(),
      );
      expect(updated).toHaveLength(0);
      const deleted = await withUserScope(intruder.id, (tx) =>
        tx.delete(entityGroupMembers).where(eq(entityGroupMembers.groupId, group.id)).returning(),
      );
      expect(deleted).toHaveLength(0);
      expect((await GroupService.get(world.groupActor, group.id)).members).toHaveLength(4);
    });

    it("a user scope sees no tenant data and a tenant scope sees no group data (the two scopes never mix)", async () => {
      await createFullGroup(world);
      const accountsInUserScope = await withUserScope(world.user.id, (tx) => tx.select().from(accounts));
      expect(accountsInUserScope).toHaveLength(0);
      const groupsInTenantScope = await withTenant(world.entities.A.organizationId, (tx) => tx.select().from(entityGroups));
      expect(groupsInTenantScope).toHaveLength(0);
    });

    it("two users may use the same group name independently; names are unique per owner", async () => {
      await GroupService.create(world.groupActor, { name: "Same" });
      await expect(GroupService.create(world.groupActor, { name: "Same" })).rejects.toThrow(GroupNameTakenError);
      const other = await createTestUser("Other");
      await GroupService.create({ userId: other.id }, { name: "Same" });
    });
  });

  describe("mapping and intercompany designation", () => {
    it("mapping needs consolidation:manage in the entity, the right type, and an existing group account", async () => {
      const group = await createFullGroup(world);
      const detail = await GroupService.get(world.groupActor, group.id);
      const asset1000 = detail.config.groupAccounts.find((g) => g.code === "1000")!;
      const sales = detail.config.groupAccounts.find((g) => g.code === "4000")!;
      const accountB = world.entities.B.accountIds;

      // Type mismatch: a revenue account cannot map to an asset group account.
      await expect(
        GroupService.mapAccount(world.groupActor, group.id, world.entities.B.organizationId, accountB["4000"]!, asset1000.id),
      ).rejects.toThrow(InvalidMappingError);

      const mapped = await GroupService.mapAccount(world.groupActor, group.id, world.entities.B.organizationId, accountB["4100"]!, sales.id);
      expect(mapped.groupAccountId).toBe(sales.id);

      // Demoted to READ_ONLY in B: the same action is refused.
      await world.setUserRole("B", "READ_ONLY");
      await expect(
        GroupService.mapAccount(world.groupActor, group.id, world.entities.B.organizationId, accountB["6100"]!, sales.id),
      ).rejects.toThrow(PermissionDeniedError);

      // Removing the override is owner-only and always possible.
      await GroupService.unmapAccount(world.groupActor, group.id, world.entities.B.organizationId, accountB["4100"]!);
      expect((await GroupService.get(world.groupActor, group.id)).config.mappings).toHaveLength(0);
    });

    it("intercompany designation validates account type, counterparty membership and self-reference; and is audited", async () => {
      const group = await createFullGroup(world);
      const A = world.entities.A;
      const B = world.entities.B;

      await expect(
        GroupService.designateIntercompany(world.groupActor, group.id, {
          organizationId: A.organizationId,
          accountId: A.accountIds["1500"]!,
          kind: "LOAN_PAYABLE", // an asset account cannot be a payable
          counterpartyOrganizationId: B.organizationId,
        }),
      ).rejects.toThrow(IntercompanyDesignationError);
      await expect(
        GroupService.designateIntercompany(world.groupActor, group.id, {
          organizationId: A.organizationId,
          accountId: A.accountIds["1500"]!,
          kind: "LOAN_RECEIVABLE",
          counterpartyOrganizationId: A.organizationId,
        }),
      ).rejects.toThrow(IntercompanyDesignationError);

      const stranger = await createTestOrg("outside");
      await expect(
        GroupService.designateIntercompany(world.groupActor, group.id, {
          organizationId: A.organizationId,
          accountId: A.accountIds["1500"]!,
          kind: "LOAN_RECEIVABLE",
          counterpartyOrganizationId: stranger.organizationId, // not in the group
        }),
      ).rejects.toThrow();

      await GroupService.designateIntercompany(world.groupActor, group.id, {
        organizationId: A.organizationId,
        accountId: A.accountIds["1500"]!,
        kind: "LOAN_RECEIVABLE",
        counterpartyOrganizationId: B.organizationId,
      });
      expect((await GroupService.get(world.groupActor, group.id)).config.intercompany).toHaveLength(1);

      const audit = await withUserScope(world.user.id, (tx) =>
        tx.select().from(entityGroupAuditLogs).where(eq(entityGroupAuditLogs.groupId, group.id)),
      );
      const row = audit.find((a) => a.action === "entity_group.intercompany_designated")!;
      expect(row).toBeDefined();
      expect((row.metadata as { roleInEntity: string }).roleInEntity).toBe("OWNER");
    });

    it("removing an entity removes its mappings and every intercompany row naming it (counterparty included)", async () => {
      const group = await createFullGroup(world);
      const A = world.entities.A;
      const B = world.entities.B;
      await GroupService.designateIntercompany(world.groupActor, group.id, {
        organizationId: A.organizationId,
        accountId: A.accountIds["1500"]!,
        kind: "LOAN_RECEIVABLE",
        counterpartyOrganizationId: B.organizationId,
      });
      await GroupService.removeEntity(world.groupActor, group.id, B.organizationId);
      const detail = await GroupService.get(world.groupActor, group.id);
      expect(detail.config.intercompany).toHaveLength(0);
      expect(detail.members).toHaveLength(3);
    });

    it("a group account in use cannot be removed", async () => {
      const group = await createFullGroup(world);
      const detail = await GroupService.get(world.groupActor, group.id);
      const sales = detail.config.groupAccounts.find((g) => g.code === "4000")!;
      await GroupService.mapAccount(world.groupActor, group.id, world.entities.B.organizationId, world.entities.B.accountIds["4100"]!, sales.id);
      await expect(GroupService.removeGroupAccount(world.groupActor, group.id, sales.id)).rejects.toThrow(GroupAccountInUseError);
    });
  });

  describe("every mutation is audited at group level, append-only", () => {
    it("records create/add/include/role/account/archive and refuses UPDATE, DELETE of the history", async () => {
      const group = await createFullGroup(world);
      await GroupService.setEntityIncluded(world.groupActor, group.id, world.entities.C.organizationId, false);
      await GroupService.setEntityRole(world.groupActor, group.id, world.entities.B.organizationId, "SUBSIDIARY");
      await GroupService.update(world.groupActor, group.id, { description: "Updated" });

      const audit = await withUserScope(world.user.id, (tx) => tx.select().from(entityGroupAuditLogs));
      const actions = audit.map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "entity_group.created",
          "entity_group.entity_added",
          "entity_group.entity_inclusion_changed",
          "entity_group.entity_role_changed",
          "entity_group.updated",
        ]),
      );
      expect(audit.every((a) => a.actorUserId === world.user.id && a.ownerUserId === world.user.id)).toBe(true);

      await expect(
        withUserScope(world.user.id, (tx) => tx.update(entityGroupAuditLogs).set({ action: "tampered" })),
      ).rejects.toThrow();
      await expect(withUserScope(world.user.id, (tx) => tx.delete(entityGroupAuditLogs))).rejects.toThrow();

      await GroupService.archive(world.groupActor, group.id);
      expect(await GroupService.list(world.groupActor)).toEqual([]);
      await expect(GroupService.get(world.groupActor, group.id)).rejects.toThrow(GroupNotFoundError);
    });
  });

  describe("adjustments are group-level, balanced, append-only and reversible only by a new row", () => {
    async function setup() {
      const group = await createFullGroup(world);
      const detail = await GroupService.get(world.groupActor, group.id);
      const cash = detail.config.groupAccounts.find((g) => g.code === "1000")!;
      const sales = detail.config.groupAccounts.find((g) => g.code === "4000")!;
      return { group, cash, sales };
    }

    it("rejects an unbalanced adjustment, a missing reason, one-sided lines and unknown accounts", async () => {
      const { group, cash, sales } = await setup();
      const base = { kind: "ADJUSTMENT" as const, effectiveDate: new Date("2026-03-31"), description: "d", reason: "r" };

      await expect(
        AdjustmentService.create(world.groupActor, group.id, {
          ...base,
          lines: [
            { groupAccountId: cash.id, debit: "100.00" },
            { groupAccountId: sales.id, credit: "99.99" },
          ],
        }),
      ).rejects.toThrow(/does not balance/);
      await expect(
        AdjustmentService.create(world.groupActor, group.id, {
          ...base,
          reason: "  ",
          lines: [
            { groupAccountId: cash.id, debit: "1" },
            { groupAccountId: sales.id, credit: "1" },
          ],
        }),
      ).rejects.toThrow(/reason/);
      await expect(
        AdjustmentService.create(world.groupActor, group.id, {
          ...base,
          lines: [
            { groupAccountId: cash.id, debit: "1", credit: "1" },
            { groupAccountId: sales.id, credit: "0" },
          ],
        }),
      ).rejects.toThrow(InvalidAdjustmentError);
      await expect(
        AdjustmentService.create(world.groupActor, group.id, {
          ...base,
          lines: [
            { groupAccountId: cash.id, debit: "1.00001" },
            { groupAccountId: sales.id, credit: "1.00001" },
          ],
        }),
      ).rejects.toThrow(/4 decimal places/);
      await expect(
        AdjustmentService.create(world.groupActor, group.id, {
          ...base,
          lines: [
            { groupAccountId: cash.id, debit: "1" },
            { groupAccountId: "11111111-1111-1111-1111-111111111111", credit: "1" },
          ],
        }),
      ).rejects.toThrow(/not in this group's chart/);
    });

    it("stores a balanced adjustment, reverses it with a NEW row, and refuses a second reversal or a reversal of a reversal", async () => {
      const { group, cash, sales } = await setup();
      const created = await AdjustmentService.create(world.groupActor, group.id, {
        kind: "ELIMINATION",
        effectiveDate: new Date("2026-03-31"),
        description: "Eliminate something",
        reason: "Documented reason",
        lines: [
          { groupAccountId: cash.id, debit: "250.5000" },
          { groupAccountId: sales.id, credit: "250.5" },
        ],
      });
      const reversal = await AdjustmentService.reverse(world.groupActor, group.id, created.id, { reason: "Posted in error" });
      await expect(AdjustmentService.reverse(world.groupActor, group.id, created.id, { reason: "again" })).rejects.toThrow(AdjustmentAlreadyReversedError);
      await expect(AdjustmentService.reverse(world.groupActor, group.id, reversal.id, { reason: "undo undo" })).rejects.toThrow(InvalidAdjustmentError);

      const list = await AdjustmentService.list(world.groupActor, group.id);
      expect(list).toHaveLength(2);
      const original = list.find((a) => a.id === created.id)!;
      expect(original.reversedById).toBe(reversal.id);
      const mirror = list.find((a) => a.id === reversal.id)!;
      expect(mirror.lines.map((l) => [l.debit, l.credit])).toEqual([
        ["0.0000", "250.5000"],
        ["250.5000", "0.0000"],
      ]);

      const audit = await withUserScope(world.user.id, (tx) => tx.select().from(entityGroupAuditLogs));
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["entity_group.adjustment_created", "entity_group.adjustment_reversed"]));
    });

    it("mm_app can only INSERT and SELECT adjustments: UPDATE and DELETE are refused by Postgres", async () => {
      const { group, cash, sales } = await setup();
      const created = await AdjustmentService.create(world.groupActor, group.id, {
        kind: "ADJUSTMENT",
        effectiveDate: new Date("2026-03-31"),
        description: "d",
        reason: "r",
        lines: [
          { groupAccountId: cash.id, debit: "1" },
          { groupAccountId: sales.id, credit: "1" },
        ],
      });
      await expect(
        withUserScope(world.user.id, (tx) => tx.update(entityGroupAdjustments).set({ description: "edited" }).where(eq(entityGroupAdjustments.id, created.id))),
      ).rejects.toThrow();
      await expect(withUserScope(world.user.id, (tx) => tx.delete(entityGroupAdjustments).where(eq(entityGroupAdjustments.id, created.id)))).rejects.toThrow();
      await expect(
        withUserScope(world.user.id, (tx) => tx.update(entityGroupAdjustmentLines).set({ debit: "9" }).where(and(eq(entityGroupAdjustmentLines.adjustmentId, created.id)))),
      ).rejects.toThrow();
      await expect(withUserScope(world.user.id, (tx) => tx.delete(entityGroupAdjustmentLines))).rejects.toThrow();
    });
  });
});
