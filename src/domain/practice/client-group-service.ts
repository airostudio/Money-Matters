import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { practiceClientGroupMembers, practiceClientGroups, practiceClientLinks } from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { PracticeAccess } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { BulkSelectionError, ClientLinkNotFoundError, PracticeValidationError } from "./errors";
import { MAX_BULK_SELECTION, type PracticeActor } from "./types";

function cleanGroupName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new PracticeValidationError("Group name is required.");
  if (name.length > 60) throw new PracticeValidationError("Group name must be 60 characters or fewer.");
  return name;
}

export interface ClientGroupView {
  id: string;
  name: string;
  clientCount: number;
}

/**
 * Client groups: practice-defined labels for clients ("Monthly BAS", "Hospitality").
 * Purely the practice's own organising data — no client data is read or written,
 * and a client is never told which groups it is in. MANAGER+ may create, rename,
 * delete and apply them; every mutation is audited in the practice log.
 */
export const ClientGroupService = {
  async list(actor: PracticeActor, practiceId: string): Promise<ClientGroupView[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const groups = await tx
        .select()
        .from(practiceClientGroups)
        .where(eq(practiceClientGroups.practiceId, practiceId))
        .orderBy(asc(practiceClientGroups.name));
      const counts = await tx
        .select({ groupId: practiceClientGroupMembers.groupId, n: sql<number>`count(*)::int` })
        .from(practiceClientGroupMembers)
        .where(eq(practiceClientGroupMembers.practiceId, practiceId))
        .groupBy(practiceClientGroupMembers.groupId);
      const byGroup = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
      return groups.map((g) => ({ id: g.id, name: g.name, clientCount: byGroup.get(g.id) ?? 0 }));
    });
  },

  async create(actor: PracticeActor, practiceId: string, name: string) {
    const clean = cleanGroupName(name);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Creating a client group");
      const [existing] = await tx
        .select({ id: practiceClientGroups.id })
        .from(practiceClientGroups)
        .where(and(eq(practiceClientGroups.practiceId, practiceId), eq(practiceClientGroups.name, clean)));
      if (existing) throw new PracticeValidationError(`You already have a group named "${clean}".`);
      const [group] = await tx
        .insert(practiceClientGroups)
        .values({ practiceId, name: clean, createdByUserId: actor.userId })
        .returning();
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_group.created",
        entityType: "ClientGroup",
        entityId: group!.id,
        after: { name: clean },
      });
      return group!;
    });
  },

  async rename(actor: PracticeActor, practiceId: string, groupId: string, name: string) {
    const clean = cleanGroupName(name);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Renaming a client group");
      const group = await loadGroup(tx, practiceId, groupId);
      await tx.update(practiceClientGroups).set({ name: clean }).where(eq(practiceClientGroups.id, groupId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_group.renamed",
        entityType: "ClientGroup",
        entityId: groupId,
        before: { name: group.name },
        after: { name: clean },
      });
    });
  },

  async remove(actor: PracticeActor, practiceId: string, groupId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Deleting a client group");
      const group = await loadGroup(tx, practiceId, groupId);
      await tx.delete(practiceClientGroupMembers).where(eq(practiceClientGroupMembers.groupId, groupId));
      await tx.delete(practiceClientGroups).where(eq(practiceClientGroups.id, groupId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_group.deleted",
        entityType: "ClientGroup",
        entityId: groupId,
        before: { name: group.name },
      });
    });
  },

  /** Adds up to MAX_BULK_SELECTION clients to the group (idempotent). One transaction, no client access. */
  async apply(actor: PracticeActor, practiceId: string, groupId: string, clientOrganizationIds: string[]) {
    const ids = [...new Set(clientOrganizationIds)];
    if (ids.length < 1 || ids.length > MAX_BULK_SELECTION) throw new BulkSelectionError();
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Applying a client group");
      const group = await loadGroup(tx, practiceId, groupId);
      const links = await tx
        .select({ id: practiceClientLinks.clientOrganizationId })
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), inArray(practiceClientLinks.clientOrganizationId, ids)));
      if (links.length !== ids.length) throw new ClientLinkNotFoundError();
      for (const clientOrganizationId of ids) {
        await tx
          .insert(practiceClientGroupMembers)
          .values({ groupId, practiceId, clientOrganizationId })
          .onConflictDoNothing();
      }
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_group.applied",
        entityType: "ClientGroup",
        entityId: groupId,
        after: { name: group.name, clientOrganizationIds: ids },
      });
      return ids.length;
    });
  },

  async removeClient(actor: PracticeActor, practiceId: string, groupId: string, clientOrganizationId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Changing a client group");
      const group = await loadGroup(tx, practiceId, groupId);
      await tx
        .delete(practiceClientGroupMembers)
        .where(and(eq(practiceClientGroupMembers.groupId, groupId), eq(practiceClientGroupMembers.clientOrganizationId, clientOrganizationId)));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_group.client_removed",
        entityType: "ClientGroup",
        entityId: groupId,
        before: { name: group.name, clientOrganizationId },
      });
    });
  },
};

async function loadGroup(tx: UserScopeDb, practiceId: string, groupId: string) {
  const [group] = await tx
    .select()
    .from(practiceClientGroups)
    .where(and(eq(practiceClientGroups.id, groupId), eq(practiceClientGroups.practiceId, practiceId)));
  if (!group) throw new PracticeValidationError("That client group does not exist.");
  return group;
}
