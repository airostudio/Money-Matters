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

/**
 * `tfn`, `bankAccountNumber`, and `bankBsb` were added for Phase 8 Slice 1
 * (AU Payroll) — a TFN is treated with the same sensitivity as a password
 * throughout this codebase (master spec §8/§44), and a bank account number
 * is record-keeping-only data nobody but `employee:manage` should ever see
 * in full (see `src/domain/payroll/sensitive-data.ts`'s doc comment).
 */
const REDACTED_FIELDS = new Set([
  "passwordHash",
  "password",
  "secret",
  "token",
  "tfn",
  "bankAccountNumber",
  "bankBsb",
]);
const REDACTED_PLACEHOLDER = "[redacted]";

export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_FIELDS.has(key) ? REDACTED_PLACEHOLDER : redactSensitive(val);
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
      before: params.before !== undefined ? (redactSensitive(params.before) as object) : null,
      after: params.after !== undefined ? (redactSensitive(params.after) as object) : null,
      metadata: params.metadata ?? null,
    });
  },

  /**
   * An entry in an organization's own audit log written by the PLATFORM (a
   * platform admin changed its seat limit, a member's role, ...) so customers
   * can see their account was changed by the platform. Recorded as a SYSTEM
   * actor with no user id: the customer sees "the platform", not the admin's
   * personal identity. `metadata.platformAdmin = true` marks it, and
   * `platformAuditId` links the matching platform_admin_audit_logs row.
   * Must run inside the same `withTenant(organizationId)` transaction as the
   * change, like `record`.
   */
  async recordPlatformAction(
    tx: TenantDb,
    organizationId: string,
    params: RecordAuditParams & { platformAuditId: string },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      organizationId,
      actorUserId: null,
      actorType: "SYSTEM",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before !== undefined ? (redactSensitive(params.before) as object) : null,
      after: params.after !== undefined ? (redactSensitive(params.after) as object) : null,
      metadata: { ...(params.metadata ?? {}), platformAdmin: true, platformAuditId: params.platformAuditId },
    });
  },
};
