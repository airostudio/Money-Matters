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
  // Phase 10 Slice 1: an API key's secret material must never reach an audit row (it is shown to the user once
  // and stored only as a hash in a non-audited table; these names are a belt-and-braces net for a future caller).
  "secretHash",
  "secret_hash",
  "apiKey",
  "api_key",
  "authorization",
  // Phase 10 Slice 2: webhook signing secrets. The raw secret is shown once and exists encrypted at rest only; neither
  // it nor its ciphertext may ever be written to an audit row (belt-and-braces: the service never passes them).
  "secretCiphertext",
  "secret_ciphertext",
  "previousSecretCiphertext",
  "previous_secret_ciphertext",
  "signingSecret",
  "signing_secret",
  "whsec",
  // Organisation lifecycle slice: an invite code is a bearer secret shown once and stored only as a hash in a
  // non-audited lookup table. (Deliberately NOT the bare word "code": account codes are audited legitimately.)
  "inviteCode",
  "invite_code",
  "codeHash",
  "code_hash",
  // Phase 10 Slice 3: integration credentials. A connection's secret (e.g. a Slack incoming-webhook URL, which is a
  // bearer secret) is shown once, stored encrypted, and must never reach an audit row; neither may its ciphertext.
  "webhookUrl",
  "webhook_url",
  "secretConfig",
  "secret_config",
  "secretKeyVersion",
  "secret_key_version",
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
/**
 * What an API-originated audit row records about the key that acted: its id and non-secret prefix (and the user
 * who created it, who is the row's `actorUserId`). Merged into EVERY audit row an API actor writes - including
 * the ones domain services write on their own - so no service needs to know the call came from the API.
 */
function apiKeyMetadata(actor: Actor): Record<string, unknown> | null {
  if (actor.type !== "API" || !actor.apiKey) return null;
  return { viaApiKey: true, apiKeyId: actor.apiKey.id, apiKeyPrefix: actor.apiKey.prefix, apiKeyCreatedBy: actor.userId };
}

/**
 * What an automation-originated audit row records: the rule (id and name) and the person whose authority bounds it (the
 * row's `actorUserId`). Merged into EVERY audit row an AUTOMATION actor writes - including the ones domain services write
 * on their own (e.g. the purchase order service) - so no service needs to know the call came from a rule.
 */
function automationMetadata(actor: Actor): Record<string, unknown> | null {
  if (actor.type !== "AUTOMATION" || !actor.automation) return null;
  return { viaAutomation: true, automationRuleId: actor.automation.ruleId, automationRuleName: actor.automation.ruleName, automationAuthorisedBy: actor.userId };
}

export const AuditService = {
  async record(tx: TenantDb, actor: Actor, params: RecordAuditParams): Promise<void> {
    const viaKey = apiKeyMetadata(actor);
    const viaRule = automationMetadata(actor);
    const extra = viaKey || viaRule ? { ...(viaKey ?? {}), ...(viaRule ?? {}) } : null;
    await tx.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorUserId: actor.type === "SYSTEM" ? null : actor.userId,
      actorType: actor.type ?? "HUMAN",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before !== undefined ? (redactSensitive(params.before) as object) : null,
      after: params.after !== undefined ? (redactSensitive(params.after) as object) : null,
      metadata: extra ? { ...(params.metadata ?? {}), ...extra } : (params.metadata ?? null),
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

  /**
   * An INFORMATIONAL entry in a client organization's own audit log about its
   * accountant practice (a link was proposed/accepted/revoked, staff were
   * assigned), so the customer can see what was done on their account. It
   * carries the OPAQUE practice id and the acting user — never the practice's
   * other clients, tasks, notes or any figure. Must run inside the same
   * `withTenant(organizationId)` transaction as the change it documents.
   */
  async recordPracticeNote(
    tx: TenantDb,
    organizationId: string,
    params: { actorUserId: string; practiceId: string; action: string; entityId: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      organizationId,
      actorUserId: params.actorUserId,
      actorType: "HUMAN",
      action: params.action,
      entityType: "AccountantPractice",
      entityId: params.entityId,
      before: null,
      after: null,
      metadata: { ...(params.metadata ?? {}), practiceId: params.practiceId, viaPractice: true },
    });
  },
};
