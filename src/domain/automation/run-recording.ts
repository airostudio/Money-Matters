import { and, eq, sql } from "drizzle-orm";
import { automationJobs, automationRules, automationRuns } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { sanitiseError } from "@/domain/webhooks/sanitize";
import type { Outcome, PassSource, PlannedJob, RuleRow } from "./engine-types";
import { AUTO_DISABLE_AFTER_FAILURES } from "./vocabulary";

/**
 * Recording a run: the append-only run-log row, the job's new state, the rule's counters and the audit row - written in
 * the SAME transaction as the action itself, so a run is recorded if and only if its effect happened.
 */

export type DisabledCode = "USER_PAUSED" | "AUTHORISER_INACTIVE" | "AUTHORISER_LACKS_PERMISSION" | "AUTO_FAILURES" | "INVALID_RULE";

/** The platform acting on its own behalf for audit rows about a rule switching itself off (like the webhook circuit breaker). */
export function systemActorFor(organizationId: string, userId: string): Actor {
  return { userId, organizationId, role: "OWNER", type: "SYSTEM" };
}

/** Switches a rule off with a visible reason and an audit row. Never deletes it. Safe to call for an already-disabled rule (no-op). */
export async function disableRuleIn(tx: TenantDb, row: Pick<RuleRow, "id" | "name" | "organizationId" | "authorisedByUserId">, code: DisabledCode, reason: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(automationRules)
    .set({ enabled: false, disabledCode: code, disabledReason: sanitiseError(reason), updatedAt: now })
    .where(and(eq(automationRules.id, row.id), eq(automationRules.organizationId, row.organizationId), eq(automationRules.enabled, true)))
    .returning({ id: automationRules.id });
  if (updated.length === 0) return false;
  await AuditService.record(tx, systemActorFor(row.organizationId, row.authorisedByUserId), {
    action: code === "AUTO_FAILURES" ? "automation_rule.auto_disabled" : "automation_rule.disabled_by_system",
    entityType: "AutomationRule",
    entityId: row.id,
    before: { enabled: true },
    after: { enabled: false, disabledCode: code, disabledReason: sanitiseError(reason), name: row.name },
  });
  return true;
}

export interface FinishOptions {
  source: PassSource;
  startedAt: Date;
  now: Date;
}

/** Writes everything that records one run. Returns whether the rule was auto-disabled by this failure. */
export async function finishIn(tx: TenantDb, planned: PlannedJob, outcome: Outcome, options: FinishOptions): Promise<{ autoDisabled: boolean }> {
  const { rule } = planned;
  const row = rule.row;
  const organizationId = row.organizationId;
  const reason = outcome.outcome === "SUCCESS" ? (outcome.note ?? null) : sanitiseError(outcome.reason);
  const created = outcome.outcome === "SUCCESS" ? (outcome.created ?? null) : null;
  const willRetry = outcome.outcome === "FAILED" && outcome.retryAt !== undefined;

  await tx.insert(automationRuns).values({
    organizationId,
    ruleId: row.id,
    ruleName: row.name,
    trigger: row.trigger,
    jobKey: planned.jobKey,
    attempt: planned.attemptsMade + 1,
    outcome: outcome.outcome,
    reason: willRetry ? `${reason} Will retry.` : reason,
    actorType: "AUTOMATION",
    actorUserId: row.authorisedByUserId,
    source: options.source,
    startedAt: options.startedAt,
    finishedAt: options.now,
    createdObjectType: created?.type ?? null,
    createdObjectId: created?.id ?? null,
  });

  const state = outcome.outcome === "SUCCESS" ? "DONE" : outcome.outcome === "SKIPPED" ? "SKIPPED" : willRetry ? "RETRY" : "FAILED";
  await tx
    .update(automationJobs)
    .set({
      state,
      attempts: sql`${automationJobs.attempts} + 1`,
      nextAttemptAt: outcome.outcome === "FAILED" && outcome.retryAt ? outcome.retryAt : null,
      leaseUntil: null,
      lastError: outcome.outcome === "SUCCESS" ? null : reason,
      updatedAt: options.now,
    })
    .where(and(eq(automationJobs.id, planned.jobId), eq(automationJobs.organizationId, organizationId)));

  let autoDisabled = false;
  if (outcome.outcome === "SUCCESS") {
    await tx
      .update(automationRules)
      .set({ consecutiveFailures: 0, lastRunAt: options.now, lastSuccessAt: options.now })
      .where(and(eq(automationRules.id, row.id), eq(automationRules.organizationId, organizationId)));
  } else if (outcome.outcome === "SKIPPED") {
    await tx
      .update(automationRules)
      .set({ lastRunAt: options.now })
      .where(and(eq(automationRules.id, row.id), eq(automationRules.organizationId, organizationId)));
  } else {
    const [updated] = await tx
      .update(automationRules)
      .set({ consecutiveFailures: sql`${automationRules.consecutiveFailures} + 1`, lastRunAt: options.now })
      .where(and(eq(automationRules.id, row.id), eq(automationRules.organizationId, organizationId)))
      .returning({ failures: automationRules.consecutiveFailures, enabled: automationRules.enabled });
    if (updated && updated.enabled && updated.failures >= AUTO_DISABLE_AFTER_FAILURES) {
      autoDisabled = await disableRuleIn(tx, row, "AUTO_FAILURES", `Automatically switched off after ${updated.failures} failed runs in a row. Last problem: ${reason ?? "unknown"}. Fix the cause, then switch it on again.`, options.now);
    }
  }

  await AuditService.record(tx, rule.actor, {
    action: `automation.run.${outcome.outcome.toLowerCase()}`,
    entityType: "AutomationRule",
    entityId: row.id,
    after: { trigger: row.trigger, jobKey: planned.jobKey, attempt: planned.attemptsMade + 1, outcome: outcome.outcome, reason, created, source: options.source },
  });
  return { autoDisabled };
}
