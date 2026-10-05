import { and, asc, eq, isNull } from "drizzle-orm";
import {
  entityGroupAccountMappings,
  entityGroupAccounts,
  entityGroupAdjustmentLines,
  entityGroupAdjustments,
  entityGroupIntercompanyAccounts,
  entityGroupMembers,
  entityGroups,
} from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { GroupNotFoundError } from "./errors";
import type { AdjustmentDef, ConsolidationConfig, GroupRole, IntercompanyDef } from "./types";

export interface GroupMemberRow {
  memberId: string;
  organizationId: string;
  role: GroupRole;
  isIncluded: boolean;
  addedByUserId: string;
  createdAt: Date;
}

export interface GroupSnapshot {
  group: { id: string; ownerUserId: string; name: string; description: string | null; createdAt: Date };
  members: GroupMemberRow[];
  config: ConsolidationConfig;
  /** Plain mapping rows including display snapshots, for the setup page. */
  mappingRows: Array<{ organizationId: string; accountId: string; accountCode: string; accountName: string; groupAccountId: string }>;
}

/**
 * Loads one group's owned configuration — group, members, group chart,
 * mappings, intercompany designations, adjustments — in ONE user-scoped
 * transaction (a handful of sequential queries on one connection). Row-level
 * security keys every one of these tables on the user, so a group that is not
 * the caller's is simply not found, and the explicit owner filter below is
 * belt and braces rather than the only protection.
 */
export async function loadGroupSnapshotIn(tx: UserScopeDb, userId: string, groupId: string): Promise<GroupSnapshot> {
  const [group] = await tx
    .select()
    .from(entityGroups)
    .where(and(eq(entityGroups.id, groupId), eq(entityGroups.ownerUserId, userId), isNull(entityGroups.archivedAt)));
  if (!group) throw new GroupNotFoundError();

  const members = await tx
    .select()
    .from(entityGroupMembers)
    .where(and(eq(entityGroupMembers.groupId, groupId), eq(entityGroupMembers.ownerUserId, userId)))
    .orderBy(asc(entityGroupMembers.createdAt));

  const groupAccounts = await tx
    .select()
    .from(entityGroupAccounts)
    .where(and(eq(entityGroupAccounts.groupId, groupId), eq(entityGroupAccounts.ownerUserId, userId)))
    .orderBy(asc(entityGroupAccounts.code));

  const mappings = await tx
    .select()
    .from(entityGroupAccountMappings)
    .where(and(eq(entityGroupAccountMappings.groupId, groupId), eq(entityGroupAccountMappings.ownerUserId, userId)));

  const intercompany = await tx
    .select()
    .from(entityGroupIntercompanyAccounts)
    .where(and(eq(entityGroupIntercompanyAccounts.groupId, groupId), eq(entityGroupIntercompanyAccounts.ownerUserId, userId)));

  const adjustmentRows = await tx
    .select()
    .from(entityGroupAdjustments)
    .where(and(eq(entityGroupAdjustments.groupId, groupId), eq(entityGroupAdjustments.ownerUserId, userId)))
    .orderBy(asc(entityGroupAdjustments.effectiveDate), asc(entityGroupAdjustments.createdAt));

  const lineRows = await tx
    .select()
    .from(entityGroupAdjustmentLines)
    .where(and(eq(entityGroupAdjustmentLines.groupId, groupId), eq(entityGroupAdjustmentLines.ownerUserId, userId)));

  const linesByAdjustment = new Map<string, typeof lineRows>();
  for (const l of lineRows) {
    const list = linesByAdjustment.get(l.adjustmentId) ?? [];
    list.push(l);
    linesByAdjustment.set(l.adjustmentId, list);
  }

  const adjustments: AdjustmentDef[] = adjustmentRows.map((a) => ({
    id: a.id,
    kind: a.kind,
    effectiveDate: a.effectiveDate,
    description: a.description,
    reason: a.reason,
    reversesAdjustmentId: a.reversesAdjustmentId,
    lines: (linesByAdjustment.get(a.id) ?? []).map((l) => ({
      groupAccountId: l.groupAccountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  }));

  return {
    group: {
      id: group.id,
      ownerUserId: group.ownerUserId,
      name: group.name,
      description: group.description,
      createdAt: group.createdAt,
    },
    members: members.map((m) => ({
      memberId: m.id,
      organizationId: m.memberOrganizationId,
      role: m.role,
      isIncluded: m.isIncluded,
      addedByUserId: m.addedByUserId,
      createdAt: m.createdAt,
    })),
    config: {
      groupAccounts: groupAccounts.map((g) => ({ id: g.id, type: g.type, code: g.code, name: g.name })),
      mappings: mappings.map((m) => ({
        organizationId: m.memberOrganizationId,
        accountId: m.accountId,
        groupAccountId: m.groupAccountId,
      })),
      intercompany: intercompany.map(
        (i): IntercompanyDef => ({
          organizationId: i.memberOrganizationId,
          accountId: i.accountId,
          accountCode: i.accountCode,
          accountName: i.accountName,
          kind: i.kind,
          counterpartyOrganizationId: i.counterpartyOrganizationId,
        }),
      ),
      adjustments,
    },
    mappingRows: mappings.map((m) => ({
      organizationId: m.memberOrganizationId,
      accountId: m.accountId,
      accountCode: m.accountCode,
      accountName: m.accountName,
      groupAccountId: m.groupAccountId,
    })),
  };
}

export function loadGroupSnapshot(userId: string, groupId: string): Promise<GroupSnapshot> {
  return withUserScope(userId, (tx) => loadGroupSnapshotIn(tx, userId, groupId));
}
