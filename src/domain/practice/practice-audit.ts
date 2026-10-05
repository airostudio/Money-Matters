import { practiceAuditLogs } from "@/db/schema";
import type { UserScopeDb } from "@/db/user-scope";
import { redactSensitive } from "@/domain/audit/audit-service";

export interface PracticeAuditParams {
  practiceId: string;
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
 * The practice-level append-only audit trail (`practice_audit_logs`). Must be
 * called inside the same user-scoped transaction as the mutation it documents,
 * exactly like `AuditService.record` for tenant data and `GroupAuditService`
 * for groups: a failed audit write rolls the mutation back.
 *
 * What a CLIENT's own audit log gets is separate and deliberately thinner: an
 * informational note with the opaque practice id and the actor only
 * (AuditService.recordPracticeNote), written in a following tenant transaction.
 */
export const PracticeAuditService = {
  async record(tx: UserScopeDb, params: PracticeAuditParams): Promise<void> {
    await tx.insert(practiceAuditLogs).values({
      practiceId: params.practiceId,
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
