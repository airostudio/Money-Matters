import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  entityGroupAccountMappings,
  entityGroupAccounts,
  entityGroupAdjustmentLines,
  entityGroupIntercompanyAccounts,
  entityGroupMembers,
  entityGroups,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { AccountService, type AccountType } from "@/domain/accounts/account-service";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { GroupAuditService } from "./group-audit";
import {
  DuplicateGroupAccountError,
  EntityAlreadyInGroupError,
  EntityNotInGroupError,
  GroupAccountInUseError,
  GroupFullError,
  GroupNameTakenError,
  GroupNotFoundError,
  IntercompanyDesignationError,
  InvalidMappingError,
  ParentAlreadyExistsError,
} from "./errors";
import { entityActorFor, loadEntityAccessMap, type GroupActor } from "./entity-access";
import { loadGroupSnapshot, type GroupSnapshot } from "./group-snapshot";
import {
  INTERCOMPANY_KIND_ACCOUNT_TYPE,
  MAX_ENTITIES_PER_GROUP,
  type GroupRole,
  type IntercompanyKind,
} from "./types";

export interface CreateGroupInput {
  name: string;
  description?: string;
}

export interface MemberView {
  memberId: string;
  organizationId: string;
  role: GroupRole;
  isIncluded: boolean;
  /** The user's CURRENT active membership in this entity; false means the entity is unavailable to them now. */
  accessible: boolean;
  /** Only ever set for an entity the user is currently a member of — never for one they are not. */
  name: string | null;
  slug: string | null;
  baseCurrency: string | null;
  /** The user's real role in the entity, when accessible. */
  userRole: string | null;
}

export interface GroupDetail {
  group: GroupSnapshot["group"];
  members: MemberView[];
  config: GroupSnapshot["config"];
  mappingRows: GroupSnapshot["mappingRows"];
}

function cleanName(raw: string, label: string): string {
  const name = raw.trim();
  if (!name) throw new Error(`${label} is required.`);
  if (name.length > 120) throw new Error(`${label} must be 120 characters or fewer.`);
  return name;
}

/** Locks the group row for the rest of the transaction (serialises concurrent changes to one group). */
async function lockOwnedGroup(tx: UserScopeDb, userId: string, groupId: string) {
  const [group] = await tx
    .select()
    .from(entityGroups)
    .where(and(eq(entityGroups.id, groupId), eq(entityGroups.ownerUserId, userId), isNull(entityGroups.archivedAt)))
    .for("update");
  if (!group) throw new GroupNotFoundError();
  return group;
}

/**
 * Group management. A group belongs to the USER who created it, and every
 * method here takes the acting user, never an organization. Who may do what:
 *
 *  - group-level changes (create, rename, archive, include/exclude an entity,
 *    set its role, edit the group chart, remove an entity or an
 *    intercompany/mapping row): the group's owner, enforced by row-level
 *    security (`owner_user_id = app.current_user_id`) as well as by the
 *    explicit owner filters here;
 *  - anything that ties an ENTITY into the group — adding it, mapping one of
 *    its accounts, designating one of its accounts as intercompany — also
 *    needs `consolidation:manage` held IN THAT ENTITY, checked against the
 *    user's real role there (an `Actor` built from their membership), and the
 *    database independently refuses an entity row for an organization the
 *    user is not an active member of.
 *
 * Every mutation writes the group audit log in the same transaction. Adding or
 * removing an entity also leaves an informational note in that entity's own
 * audit log (opaque group id + actor only — never the group's name, its other
 * entities or any figure), as a separate sequential transaction afterwards.
 */
export const GroupService = {
  async create(actor: GroupActor, input: CreateGroupInput) {
    const name = cleanName(input.name, "Group name");
    return withUserScope(actor.userId, async (tx) => {
      const [existing] = await tx
        .select({ id: entityGroups.id })
        .from(entityGroups)
        .where(and(eq(entityGroups.ownerUserId, actor.userId), eq(entityGroups.name, name)));
      if (existing) throw new GroupNameTakenError(name);

      const [group] = await tx
        .insert(entityGroups)
        .values({ ownerUserId: actor.userId, name, description: input.description?.trim() || null })
        .returning();
      if (!group) throw new Error("Failed to create group.");

      await GroupAuditService.record(tx, {
        groupId: group.id,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.created",
        entityType: "EntityGroup",
        entityId: group.id,
        after: { name: group.name, description: group.description },
      });
      return group;
    });
  },

  async list(actor: GroupActor) {
    return withUserScope(actor.userId, async (tx) => {
      const groups = await tx
        .select()
        .from(entityGroups)
        .where(and(eq(entityGroups.ownerUserId, actor.userId), isNull(entityGroups.archivedAt)))
        .orderBy(asc(entityGroups.name));
      const counts = await tx
        .select({ groupId: entityGroupMembers.groupId, n: sql<number>`count(*)::int` })
        .from(entityGroupMembers)
        .where(eq(entityGroupMembers.ownerUserId, actor.userId))
        .groupBy(entityGroupMembers.groupId);
      const countByGroup = new Map(counts.map((c) => [c.groupId, c.n]));
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        memberCount: countByGroup.get(g.id) ?? 0,
        createdAt: g.createdAt,
      }));
    });
  },

  /** Group + members (named only where the user still has access) + configuration. */
  async get(actor: GroupActor, groupId: string): Promise<GroupDetail> {
    const snapshot = await loadGroupSnapshot(actor.userId, groupId);
    const access = await loadEntityAccessMap(actor.userId);
    const members: MemberView[] = snapshot.members.map((m) => {
      const entry = access.get(m.organizationId);
      return {
        memberId: m.memberId,
        organizationId: m.organizationId,
        role: m.role,
        isIncluded: m.isIncluded,
        accessible: !!entry,
        name: entry?.organization.name ?? null,
        slug: entry?.organization.slug ?? null,
        baseCurrency: entry?.organization.baseCurrency ?? null,
        userRole: entry?.role ?? null,
      };
    });
    return { group: snapshot.group, members, config: snapshot.config, mappingRows: snapshot.mappingRows };
  },

  async update(actor: GroupActor, groupId: string, input: { name?: string; description?: string | null }) {
    return withUserScope(actor.userId, async (tx) => {
      const before = await lockOwnedGroup(tx, actor.userId, groupId);
      const name = input.name !== undefined ? cleanName(input.name, "Group name") : before.name;
      if (name !== before.name) {
        const [clash] = await tx
          .select({ id: entityGroups.id })
          .from(entityGroups)
          .where(and(eq(entityGroups.ownerUserId, actor.userId), eq(entityGroups.name, name)));
        if (clash) throw new GroupNameTakenError(name);
      }
      const description = input.description !== undefined ? input.description?.trim() || null : before.description;
      const [after] = await tx
        .update(entityGroups)
        .set({ name, description, updatedAt: new Date() })
        .where(eq(entityGroups.id, groupId))
        .returning();
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.updated",
        entityType: "EntityGroup",
        entityId: groupId,
        before: { name: before.name, description: before.description },
        after: { name, description },
      });
      return after!;
    });
  },

  /** Groups are archived, never deleted: their append-only adjustments and audit trail stay attached. */
  async archive(actor: GroupActor, groupId: string) {
    return withUserScope(actor.userId, async (tx) => {
      const before = await lockOwnedGroup(tx, actor.userId, groupId);
      await tx.update(entityGroups).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(entityGroups.id, groupId));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.archived",
        entityType: "EntityGroup",
        entityId: groupId,
        before: { name: before.name },
      });
    });
  },

  /**
   * Adds an organization to the group. Requires, in THAT organization, an
   * active membership whose role holds `consolidation:manage` — a user who is
   * merely READ_ONLY there cannot pull it into a group, and an organization
   * they do not belong to is refused identically whether or not it exists.
   *
   * The first entity added becomes the PARENT (unless a role is given) and
   * seeds the group chart of accounts from its own chart; later entities match
   * those accounts by (type, code) or land in "Unmapped" until mapped.
   */
  async addEntity(actor: GroupActor, groupId: string, organizationId: string, role?: GroupRole) {
    const access = await loadEntityAccessMap(actor.userId);
    const { actor: entityActor, access: entry } = entityActorFor(actor, organizationId, access);
    assertPermission(entityActor, "consolidation:manage");

    // Peek (sequential, own connection) to decide whether the chart needs seeding.
    const needsSeed = await withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(entityGroupAccounts)
        .where(eq(entityGroupAccounts.groupId, groupId));
      return (row?.n ?? 0) === 0;
    });

    const seedAccounts = needsSeed ? await AccountService.list(entityActor) : [];

    const member = await withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);

      const existing = await tx
        .select()
        .from(entityGroupMembers)
        .where(and(eq(entityGroupMembers.groupId, groupId), eq(entityGroupMembers.ownerUserId, actor.userId)));
      if (existing.some((m) => m.memberOrganizationId === organizationId)) throw new EntityAlreadyInGroupError();
      if (existing.length >= MAX_ENTITIES_PER_GROUP) throw new GroupFullError();

      const hasParent = existing.some((m) => m.role === "PARENT");
      const resolvedRole: GroupRole = role ?? (hasParent ? "SUBSIDIARY" : "PARENT");
      if (resolvedRole === "PARENT" && hasParent) throw new ParentAlreadyExistsError();

      const [inserted] = await tx
        .insert(entityGroupMembers)
        .values({
          groupId,
          ownerUserId: actor.userId,
          memberOrganizationId: organizationId,
          role: resolvedRole,
          addedByUserId: actor.userId,
        })
        .returning();
      if (!inserted) throw new Error("Failed to add the entity to the group.");

      let seeded = 0;
      if (existing.length === 0 && seedAccounts.length > 0) {
        const [chart] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(entityGroupAccounts)
          .where(eq(entityGroupAccounts.groupId, groupId));
        if ((chart?.n ?? 0) === 0) {
          await tx.insert(entityGroupAccounts).values(
            seedAccounts.map((a) => ({
              groupId,
              ownerUserId: actor.userId,
              type: a.type,
              code: a.code,
              name: a.name,
            })),
          );
          seeded = seedAccounts.length;
        }
      }

      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.entity_added",
        entityType: "EntityGroupMember",
        entityId: inserted.id,
        after: { organizationId, name: entry.organization.name, role: resolvedRole },
        // The user's real role in the entity at the moment the permission was checked.
        metadata: { roleInEntity: entry.role, permissionChecked: "consolidation:manage", groupAccountsSeeded: seeded },
      });
      return inserted;
    });

    await withTenant(organizationId, (tx) =>
      AuditService.record(tx, entityActor, {
        action: "consolidation.entity_added_to_group",
        entityType: "Organization",
        entityId: organizationId,
        metadata: { groupId },
      }),
    );
    return member;
  },

  /** Owner-only. Needs no entity permission (you can always take an entity out of your own group, e.g. after losing access). */
  async removeEntity(actor: GroupActor, groupId: string, organizationId: string) {
    const removed = await withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [member] = await tx
        .select()
        .from(entityGroupMembers)
        .where(and(eq(entityGroupMembers.groupId, groupId), eq(entityGroupMembers.memberOrganizationId, organizationId)));
      if (!member) throw new EntityNotInGroupError();

      const [mappingCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(entityGroupAccountMappings)
        .where(and(eq(entityGroupAccountMappings.groupId, groupId), eq(entityGroupAccountMappings.memberOrganizationId, organizationId)));
      // Intercompany rows of this entity AND ones naming it as counterparty are removed by FK cascade.
      await tx.delete(entityGroupMembers).where(eq(entityGroupMembers.id, member.id));

      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.entity_removed",
        entityType: "EntityGroupMember",
        entityId: member.id,
        before: { organizationId, role: member.role, isIncluded: member.isIncluded },
        metadata: { mappingsRemoved: mappingCount?.n ?? 0 },
      });
      return member;
    });

    // Informational note in the entity's own log, only if the user still has a real,
    // sufficiently privileged role there (never write into a log you cannot act in).
    const access = await loadEntityAccessMap(actor.userId);
    const entry = access.get(organizationId);
    if (entry && roleHasPermission(entry.role, "consolidation:manage")) {
      const { actor: entityActor } = entityActorFor(actor, organizationId, access);
      await withTenant(organizationId, (tx) =>
        AuditService.record(tx, entityActor, {
          action: "consolidation.entity_removed_from_group",
          entityType: "Organization",
          entityId: organizationId,
          metadata: { groupId },
        }),
      );
    }
    return removed;
  },

  async setEntityRole(actor: GroupActor, groupId: string, organizationId: string, role: GroupRole) {
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const members = await tx.select().from(entityGroupMembers).where(eq(entityGroupMembers.groupId, groupId));
      const member = members.find((m) => m.memberOrganizationId === organizationId);
      if (!member) throw new EntityNotInGroupError();
      if (role === "PARENT" && members.some((m) => m.role === "PARENT" && m.id !== member.id)) {
        throw new ParentAlreadyExistsError();
      }
      await tx.update(entityGroupMembers).set({ role, updatedAt: new Date() }).where(eq(entityGroupMembers.id, member.id));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.entity_role_changed",
        entityType: "EntityGroupMember",
        entityId: member.id,
        before: { role: member.role },
        after: { role },
        metadata: { organizationId },
      });
    });
  },

  /** The owner's own include/exclude switch for an entity — a choice, not an access change. */
  async setEntityIncluded(actor: GroupActor, groupId: string, organizationId: string, isIncluded: boolean) {
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [member] = await tx
        .select()
        .from(entityGroupMembers)
        .where(and(eq(entityGroupMembers.groupId, groupId), eq(entityGroupMembers.memberOrganizationId, organizationId)));
      if (!member) throw new EntityNotInGroupError();
      await tx.update(entityGroupMembers).set({ isIncluded, updatedAt: new Date() }).where(eq(entityGroupMembers.id, member.id));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.entity_inclusion_changed",
        entityType: "EntityGroupMember",
        entityId: member.id,
        before: { isIncluded: member.isIncluded },
        after: { isIncluded },
        metadata: { organizationId },
      });
    });
  },

  // -------------------------------------------------------------------------
  // The group's own chart of accounts
  // -------------------------------------------------------------------------

  async addGroupAccount(actor: GroupActor, groupId: string, input: { type: AccountType; code: string; name: string }) {
    const code = cleanName(input.code, "Account code");
    const name = cleanName(input.name, "Account name");
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [dup] = await tx
        .select({ id: entityGroupAccounts.id })
        .from(entityGroupAccounts)
        .where(and(eq(entityGroupAccounts.groupId, groupId), eq(entityGroupAccounts.type, input.type), eq(entityGroupAccounts.code, code)));
      if (dup) throw new DuplicateGroupAccountError(input.type, code);
      const [created] = await tx
        .insert(entityGroupAccounts)
        .values({ groupId, ownerUserId: actor.userId, type: input.type, code, name })
        .returning();
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.account_added",
        entityType: "EntityGroupAccount",
        entityId: created!.id,
        after: { type: input.type, code, name },
      });
      return created!;
    });
  },

  async removeGroupAccount(actor: GroupActor, groupId: string, groupAccountId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [account] = await tx
        .select()
        .from(entityGroupAccounts)
        .where(and(eq(entityGroupAccounts.id, groupAccountId), eq(entityGroupAccounts.groupId, groupId)));
      if (!account) throw new InvalidMappingError("That group account does not exist.");
      const [mapped] = await tx
        .select({ id: entityGroupAccountMappings.id })
        .from(entityGroupAccountMappings)
        .where(eq(entityGroupAccountMappings.groupAccountId, groupAccountId));
      const [adjusted] = await tx
        .select({ id: entityGroupAdjustmentLines.id })
        .from(entityGroupAdjustmentLines)
        .where(eq(entityGroupAdjustmentLines.groupAccountId, groupAccountId));
      if (mapped || adjusted) throw new GroupAccountInUseError();
      await tx.delete(entityGroupAccounts).where(eq(entityGroupAccounts.id, groupAccountId));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.account_removed",
        entityType: "EntityGroupAccount",
        entityId: groupAccountId,
        before: { type: account.type, code: account.code, name: account.name },
      });
    });
  },

  // -------------------------------------------------------------------------
  // Account mapping
  // -------------------------------------------------------------------------

  /**
   * Maps one of an entity's accounts to a group account (overriding the
   * default same-(type, code) rule). Needs `consolidation:manage` in that
   * entity (the user's real role there), and the account is looked up through
   * the entity's OWN tenant transaction with that role — a mapping can never
   * name an account the user cannot read in the entity.
   */
  async mapAccount(actor: GroupActor, groupId: string, organizationId: string, accountId: string, groupAccountId: string) {
    const access = await loadEntityAccessMap(actor.userId);
    const { actor: entityActor, access: entry } = entityActorFor(actor, organizationId, access);
    assertPermission(entityActor, "consolidation:manage");

    const account = await AccountService.get(entityActor, accountId);
    if (!account) throw new InvalidMappingError("That account does not exist in that entity.");

    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [member] = await tx
        .select({ id: entityGroupMembers.id })
        .from(entityGroupMembers)
        .where(and(eq(entityGroupMembers.groupId, groupId), eq(entityGroupMembers.memberOrganizationId, organizationId)));
      if (!member) throw new EntityNotInGroupError();

      const [target] = await tx
        .select()
        .from(entityGroupAccounts)
        .where(and(eq(entityGroupAccounts.id, groupAccountId), eq(entityGroupAccounts.groupId, groupId)));
      if (!target) throw new InvalidMappingError("That group account does not exist.");
      if (target.type !== account.type) {
        throw new InvalidMappingError(
          `A ${account.type.toLowerCase()} account cannot be mapped to a ${target.type.toLowerCase()} group account.`,
        );
      }

      const [before] = await tx
        .select()
        .from(entityGroupAccountMappings)
        .where(
          and(
            eq(entityGroupAccountMappings.groupId, groupId),
            eq(entityGroupAccountMappings.memberOrganizationId, organizationId),
            eq(entityGroupAccountMappings.accountId, accountId),
          ),
        );
      if (before) await tx.delete(entityGroupAccountMappings).where(eq(entityGroupAccountMappings.id, before.id));

      const [created] = await tx
        .insert(entityGroupAccountMappings)
        .values({
          groupId,
          ownerUserId: actor.userId,
          memberOrganizationId: organizationId,
          accountId,
          accountCode: account.code,
          accountName: account.name,
          groupAccountId,
        })
        .returning();

      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.account_mapped",
        entityType: "EntityGroupAccountMapping",
        entityId: created!.id,
        before: before ? { groupAccountId: before.groupAccountId } : undefined,
        after: { organizationId, accountId, accountCode: account.code, groupAccountId },
        metadata: { roleInEntity: entry.role, permissionChecked: "consolidation:manage" },
      });
      return created!;
    });
  },

  /** Back to the default rule. Owner-only. */
  async unmapAccount(actor: GroupActor, groupId: string, organizationId: string, accountId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [before] = await tx
        .select()
        .from(entityGroupAccountMappings)
        .where(
          and(
            eq(entityGroupAccountMappings.groupId, groupId),
            eq(entityGroupAccountMappings.memberOrganizationId, organizationId),
            eq(entityGroupAccountMappings.accountId, accountId),
          ),
        );
      if (!before) return;
      await tx.delete(entityGroupAccountMappings).where(eq(entityGroupAccountMappings.id, before.id));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.account_unmapped",
        entityType: "EntityGroupAccountMapping",
        entityId: before.id,
        before: { organizationId, accountId, groupAccountId: before.groupAccountId },
      });
    });
  },

  // -------------------------------------------------------------------------
  // Intercompany designation
  // -------------------------------------------------------------------------

  /**
   * Designates an entity account as intercompany with a named counterparty
   * entity (which must itself be a member of the group). Needs
   * `consolidation:manage` in the entity that owns the account. Re-designating
   * the same account replaces the previous designation (audited).
   */
  async designateIntercompany(
    actor: GroupActor,
    groupId: string,
    input: { organizationId: string; accountId: string; kind: IntercompanyKind; counterpartyOrganizationId: string },
  ) {
    if (input.organizationId === input.counterpartyOrganizationId) {
      throw new IntercompanyDesignationError("An entity cannot be its own intercompany counterparty.");
    }
    const access = await loadEntityAccessMap(actor.userId);
    const { actor: entityActor, access: entry } = entityActorFor(actor, input.organizationId, access);
    assertPermission(entityActor, "consolidation:manage");

    const account = await AccountService.get(entityActor, input.accountId);
    if (!account) throw new IntercompanyDesignationError("That account does not exist in that entity.");
    const expected = INTERCOMPANY_KIND_ACCOUNT_TYPE[input.kind];
    if (account.type !== expected) {
      throw new IntercompanyDesignationError(
        `A ${input.kind.replace("_", " ").toLowerCase()} account must be a ${expected.toLowerCase()} account, but ${account.code} is ${account.type.toLowerCase()}.`,
      );
    }

    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const members = await tx.select().from(entityGroupMembers).where(eq(entityGroupMembers.groupId, groupId));
      const ids = new Set(members.map((m) => m.memberOrganizationId));
      if (!ids.has(input.organizationId) || !ids.has(input.counterpartyOrganizationId)) throw new EntityNotInGroupError();

      const [before] = await tx
        .select()
        .from(entityGroupIntercompanyAccounts)
        .where(
          and(
            eq(entityGroupIntercompanyAccounts.groupId, groupId),
            eq(entityGroupIntercompanyAccounts.memberOrganizationId, input.organizationId),
            eq(entityGroupIntercompanyAccounts.accountId, input.accountId),
          ),
        );
      if (before) await tx.delete(entityGroupIntercompanyAccounts).where(eq(entityGroupIntercompanyAccounts.id, before.id));

      const [created] = await tx
        .insert(entityGroupIntercompanyAccounts)
        .values({
          groupId,
          ownerUserId: actor.userId,
          memberOrganizationId: input.organizationId,
          accountId: input.accountId,
          accountCode: account.code,
          accountName: account.name,
          kind: input.kind,
          counterpartyOrganizationId: input.counterpartyOrganizationId,
        })
        .returning();

      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.intercompany_designated",
        entityType: "EntityGroupIntercompanyAccount",
        entityId: created!.id,
        before: before ? { kind: before.kind, counterpartyOrganizationId: before.counterpartyOrganizationId } : undefined,
        after: {
          organizationId: input.organizationId,
          accountId: input.accountId,
          accountCode: account.code,
          kind: input.kind,
          counterpartyOrganizationId: input.counterpartyOrganizationId,
        },
        metadata: { roleInEntity: entry.role, permissionChecked: "consolidation:manage" },
      });
      return created!;
    });
  },

  /** Owner-only. */
  async removeIntercompany(actor: GroupActor, groupId: string, organizationId: string, accountId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await lockOwnedGroup(tx, actor.userId, groupId);
      const [before] = await tx
        .select()
        .from(entityGroupIntercompanyAccounts)
        .where(
          and(
            eq(entityGroupIntercompanyAccounts.groupId, groupId),
            eq(entityGroupIntercompanyAccounts.memberOrganizationId, organizationId),
            eq(entityGroupIntercompanyAccounts.accountId, accountId),
          ),
        );
      if (!before) return;
      await tx.delete(entityGroupIntercompanyAccounts).where(eq(entityGroupIntercompanyAccounts.id, before.id));
      await GroupAuditService.record(tx, {
        groupId,
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "entity_group.intercompany_removed",
        entityType: "EntityGroupIntercompanyAccount",
        entityId: before.id,
        before: { organizationId, accountId, kind: before.kind, counterpartyOrganizationId: before.counterpartyOrganizationId },
      });
    });
  },

  /**
   * The chart of accounts of every member entity the user can manage, for the
   * mapping / intercompany setup screen. One entity at a time, each through
   * `AccountService.list` with the user's real role in that entity; an entity
   * the user cannot read or manage simply does not appear.
   */
  async listManageableEntityCharts(actor: GroupActor, groupId: string) {
    const snapshot = await loadGroupSnapshot(actor.userId, groupId);
    const access = await loadEntityAccessMap(actor.userId);
    const charts: Array<{
      organizationId: string;
      name: string;
      slug: string;
      accounts: Array<{ id: string; code: string; name: string; type: AccountType }>;
    }> = [];
    for (const member of snapshot.members) {
      const entry = access.get(member.organizationId);
      if (!entry || !roleHasPermission(entry.role, "consolidation:manage") || !roleHasPermission(entry.role, "account:read")) continue;
      const { actor: entityActor } = entityActorFor(actor, member.organizationId, access);
      const accounts = await AccountService.list(entityActor);
      charts.push({
        organizationId: member.organizationId,
        name: entry.organization.name,
        slug: entry.organization.slug,
        accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
      });
    }
    return charts;
  },
};
