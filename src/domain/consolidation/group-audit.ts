import { entityGroupAuditLogs } from "@/db/schema";
import type { UserScopeDb } from "@/db/user-scope";
import { redactSensitive } from "@/domain/audit/audit-service";

export interface GroupAuditParams {
  groupId: string;
  /** The group's owner (the row-level-security key). */
  ownerUserId: string;
  actorUserId: string;
  actorType?: "HUMAN" | "AI" | "SYSTEM";
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Group-level append-only audit trail (`entity_group_audit_logs`). Must be
 * called inside the same user-scoped transaction as the mutation it documents,
 * exactly like `AuditService.record` for tenant data — a failed audit write
 * rolls the mutation back.
 *
 * Which log gets what: the GROUP log records everything done to the group (and
 * the user's real role in an entity when a permission was checked there). An
 * entity's OWN audit log gets only an informational note, written by
 * GroupService inside that entity's tenant transaction, when the entity is
 * added to or removed from a group — it carries the opaque group id and the
 * actor, never the group name, the other entities, or any figure.
 */
export const GroupAuditService = {
  async record(tx: UserScopeDb, params: GroupAuditParams): Promise<void> {
    await tx.insert(entityGroupAuditLogs).values({
      groupId: params.groupId,
      ownerUserId: params.ownerUserId,
      actorUserId: params.actorUserId,
      actorType: params.actorType ?? "HUMAN",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before !== undefined ? (redactSensitive(params.before) as object) : null,
      after: params.after !== undefined ? (redactSensitive(params.after) as object) : null,
      metadata: params.metadata ?? null,
    });
  },
};
