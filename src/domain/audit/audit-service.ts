import { auditLogs } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import type { Actor } from "@/domain/permissions/permission-service";

export interface RecordAuditParams {
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

const REDACTED_FIELDS = new Set(["passwordHash", "password", "secret", "token"]);
const REDACTED_PLACEHOLDER = "[redacted]";

function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_FIELDS.has(key) ? REDACTED_PLACEHOLDER : redact(val);
  }
  return out;
}

/**
 * Append-only audit trail (master spec §44). `record()` must be called
 * inside the same transaction as the mutation it documents, so a failed
 * audit write rolls back the mutation too — see docs/architecture.md §6.
 */
export const AuditService = {
  async record(tx: TenantDb, actor: Actor, params: RecordAuditParams): Promise<void> {
    await tx.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorUserId: actor.type === "SYSTEM" ? null : actor.userId,
      actorType: actor.type ?? "HUMAN",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before !== undefined ? (redact(params.before) as object) : null,
      after: params.after !== undefined ? (redact(params.after) as object) : null,
      metadata: params.metadata ?? null,
    });
  },
};
