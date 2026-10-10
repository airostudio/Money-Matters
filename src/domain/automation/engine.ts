import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { automationJobs, automationRules, automationRuns, domainEvents, organizationMemberships, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { Actor } from "@/domain/permissions/permission-service";
import { assertHumanAutomationManager } from "./guards";
import { contextFromEvent, parseJobContext, type JobContext } from "./context";
import { emptyPassResult, type ParsedRule, type PassDeps, type PassResult, type PassSource, type PlannedJob, type RuleRow } from "./engine-types";
import { executeJob } from "./executors";
import { resolveExecutionIdentity, type AuthoriserState } from "./identity";
import { disableRuleIn, finishIn } from "./run-recording";
import { rearmReorderJobs, scanBelowReorder, scanBillsDueSoon, scanOverdueInvoices, type ScanCandidate } from "./scans";
import {
  AUTOMATION_RETENTION_DAYS,
  EVENT_BATCH,
  JOB_LEASE_MS,
  MAX_EVENT_AGE_MS,
  MAX_ORG_RUNS_PER_DAY,
  MAX_ORG_RUNS_PER_PASS,
  MAX_RULES_PER_ORG,
  MAX_RULE_RUNS_PER_DAY,
  MAX_RULE_RUNS_PER_PASS,
  RULE_EVENT_SKEW_MS,
  eventJobKey,
  evaluateConditions,
  isEventTrigger,
  isScanTrigger,
  validateRuleSpec,
} from "./vocabulary";

/**
 * THE EVALUATION PASS (docs/architecture.md section 13). One call evaluates ONE organization:
 *
 *   phase 1  ONE short transaction ("plan"): try-lock, read the archived / paused flags, load the rules, RE-VALIDATE each
 *            one and resolve its execution identity from its authoriser's CURRENT membership, look at pending outbox events
 *            and run the bounded scans, claim work by inserting job rows (the UNIQUE (rule, key) is the dedupe), COMMIT;
 *   phase 2  for each claimed job, SEQUENTIALLY: run the action. Every action records its run, job and counters in the same
 *            transaction as its effect; a channel send holds NO transaction while the HTTP call is in flight.
 *
 * It is called on demand ("Run automations now"), best-effort after a response (the same `waitUntil` mechanism the
 * webhook slice uses) and whenever outbox events are dispatched. There is no scheduler. Nothing here uses Promise.all, a
 * private connection or a timer.
 *
 * Safety rails, each tested: archived organization -> nothing runs and events stay pending; "pause all" is read on EVERY
 * pass with no caching; a rule whose authoriser is gone / suspended / no longer allowed is switched off (visibly), not
 * deleted; per-pass and per-day caps bound the work; events the automation itself emitted (`origin = automation`) are never
 * read; a rule only reacts to events from after it was last enabled or edited, and never to events from while "pause all" was on.
 */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const lastPurgeAt = new Map<string, number>();
const STALE_BATCH = 10;

interface PlanInfo {
  slug: string;
  baseCurrency: string;
}

interface Plan {
  result: PassResult;
  info: PlanInfo | null;
  jobs: PlannedJob[];
}

type Candidate = { rule: ParsedRule; jobKey: string; context: JobContext };

function ruleSpecOf(row: RuleRow) {
  return validateRuleSpec({ name: row.name, description: row.description, trigger: row.trigger, triggerParams: row.triggerParams, conditions: row.conditions, action: row.action });
}

async function plan(organizationId: string, source: PassSource, deps: PassDeps): Promise<Plan> {
  const now = (deps.now ?? (() => new Date()))();
  const result = emptyPassResult();
  return withTenant(organizationId, async (tx): Promise<Plan> => {
    // ONE statement: the try-lock, the archived flag, the emergency switch, and what links / currency need.
    const head = (await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`automation-pass:${organizationId}`})) AS got,
                 (SELECT archived_at IS NOT NULL FROM organizations WHERE id = ${organizationId}) AS archived,
                 (SELECT slug FROM organizations WHERE id = ${organizationId}) AS slug,
                 (SELECT base_currency FROM organizations WHERE id = ${organizationId}) AS base_currency,
                 coalesce((SELECT all_paused FROM automation_settings WHERE organization_id = ${organizationId}), false) AS paused,
                 (SELECT paused_at FROM automation_settings WHERE organization_id = ${organizationId}) AS paused_at,
                 (SELECT updated_at FROM automation_settings WHERE organization_id = ${organizationId}) AS settings_updated_at`,
    )).rows as { got: boolean; archived: boolean | null; slug: string | null; base_currency: string | null; paused: boolean; paused_at: Date | null; settings_updated_at: Date | null }[];
    const h = head[0];
    if (!h || !h.got) return { result: { ...result, skipped: "busy" }, info: null, jobs: [] };
    if (h.archived) return { result: { ...result, skipped: "archived" }, info: null, jobs: [] };
    if (h.paused) return { result: { ...result, skipped: "paused" }, info: null, jobs: [] };
    const info: PlanInfo = { slug: h.slug ?? "", baseCurrency: h.base_currency ?? "AUD" };
    // Events that happened while "pause all" was on never fire after it is lifted: the resume time is the floor for events.
    const resumeFloor = h.paused_at && h.settings_updated_at ? new Date(h.settings_updated_at) : null;

    const rows = await tx
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.organizationId, organizationId), eq(automationRules.enabled, true)))
      .orderBy(asc(automationRules.createdAt), asc(automationRules.id))
      .limit(MAX_RULES_PER_ORG);
    if (rows.length === 0) return { result, info, jobs: [] };

    // The authorisers' CURRENT standing: one query, never cached between passes.
    const authoriserIds = [...new Set(rows.map((r) => r.authorisedByUserId))];
    const memberRows = await tx
      .select({ userId: users.id, role: organizationMemberships.role, active: organizationMemberships.isActive, disabledAt: users.disabledAt })
      .from(users)
      .leftJoin(organizationMemberships, and(eq(organizationMemberships.userId, users.id), eq(organizationMemberships.organizationId, organizationId)))
      .where(inArray(users.id, authoriserIds));
    const standing = new Map<string, AuthoriserState>(
      memberRows.map((m) => [m.userId, { userId: m.userId, role: m.role ?? null, membershipActive: m.active ?? null, userDisabledAt: m.disabledAt }]),
    );

    // Re-validate every rule and resolve its identity. A rule that fails either is switched off with a visible reason.
    const parsed: ParsedRule[] = [];
    for (const row of rows) {
      const spec = ruleSpecOf(row);
      if (!spec.ok) {
        if (await disableRuleIn(tx, row, "INVALID_RULE", `The rule is no longer valid and was switched off: ${spec.issues[0]?.message ?? "invalid"}`, now)) result.rulesDisabled += 1;
        continue;
      }
      const identity = resolveExecutionIdentity(
        { id: row.id, name: row.name, organizationId, trigger: spec.spec.trigger, actionType: spec.spec.action.type },
        standing.get(row.authorisedByUserId),
      );
      if (!identity.ok) {
        if (await disableRuleIn(tx, row, identity.code, identity.reason, now)) result.rulesDisabled += 1;
        continue;
      }
      parsed.push({ row, spec: spec.spec, actor: identity.actor });
    }
    if (parsed.length === 0) return { result, info, jobs: [] };

    // ---- caps ---------------------------------------------------------------------------------------------------------
    const dayRows = await tx
      .select({ ruleId: automationJobs.ruleId, n: sql<number>`count(*)::int` })
      .from(automationJobs)
      .where(and(eq(automationJobs.organizationId, organizationId), gte(automationJobs.createdAt, new Date(now.getTime() - 86_400_000)), sql`${automationJobs.state} <> 'SKIPPED'`))
      .groupBy(automationJobs.ruleId);
    const dayUsed = new Map<string, number>(dayRows.map((r) => [r.ruleId, r.n]));
    let orgDay = dayRows.reduce((sum, r) => sum + r.n, 0);
    const passByRule = new Map<string, number>();
    let orgPass = 0;
    /** `force` lets the first event of a pass be handled whole even if it alone exceeds the per-pass organization cap (otherwise it could never be processed). */
    const take = (ruleId: string, force = false): "ok" | "pass_cap" | "day_cap" => {
      if ((dayUsed.get(ruleId) ?? 0) >= MAX_RULE_RUNS_PER_DAY || orgDay >= MAX_ORG_RUNS_PER_DAY) return "day_cap";
      if ((passByRule.get(ruleId) ?? 0) >= MAX_RULE_RUNS_PER_PASS || (!force && orgPass >= MAX_ORG_RUNS_PER_PASS)) return "pass_cap";
      dayUsed.set(ruleId, (dayUsed.get(ruleId) ?? 0) + 1);
      passByRule.set(ruleId, (passByRule.get(ruleId) ?? 0) + 1);
      orgDay += 1;
      orgPass += 1;
      return "ok";
    };

    const fresh: Candidate[] = [];
    const capSkipped: Candidate[] = [];

    // ---- event-driven triggers --------------------------------------------------------------------------------------
    const eventRules = parsed.filter((r) => isEventTrigger(r.spec.trigger));
    if (eventRules.length > 0) {
      const ruleFloor = (r: ParsedRule) => Math.max(r.row.updatedAt.getTime() - RULE_EVENT_SKEW_MS, resumeFloor ? resumeFloor.getTime() : 0);
      const floor = new Date(Math.max(Math.min(...eventRules.map(ruleFloor)), now.getTime() - MAX_EVENT_AGE_MS));
      const events = await tx
        .select({ id: domainEvents.id, type: domainEvents.type, payload: domainEvents.payload, occurredAt: domainEvents.occurredAt })
        .from(domainEvents)
        .where(and(eq(domainEvents.organizationId, organizationId), eq(domainEvents.origin, "user"), isNull(domainEvents.automationProcessedAt), gte(domainEvents.occurredAt, floor)))
        .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id))
        .limit(EVENT_BATCH);
      const handled: string[] = [];
      for (const event of events) {
        const matching = eventRules.filter((r) => r.spec.trigger === event.type && event.occurredAt.getTime() >= ruleFloor(r));
        const candidates: Candidate[] = [];
        for (const rule of matching) {
          const context = contextFromEvent(rule.spec.trigger, event.id, event.payload);
          if (evaluateConditions(rule.spec.conditions, context.facts, rule.spec.trigger)) candidates.push({ rule, jobKey: eventJobKey(event.id), context });
        }
        // Would this event push the pass past a per-pass cap? Then stop HERE: this event and later ones stay unprocessed for the next pass.
        const wouldExceed = candidates.some((c) => (passByRule.get(c.rule.row.id) ?? 0) >= MAX_RULE_RUNS_PER_PASS) || (orgPass > 0 && orgPass + candidates.length > MAX_ORG_RUNS_PER_PASS);
        if (wouldExceed) {
          result.capped = true;
          break;
        }
        const firstOfPass = orgPass === 0;
        for (const candidate of candidates) {
          const verdict = take(candidate.rule.row.id, firstOfPass);
          if (verdict === "ok") fresh.push(candidate);
          else {
            // A daily cap is a hard stop for today: the event is recorded as skipped rather than left to block the queue.
            capSkipped.push(candidate);
            result.capped = true;
          }
        }
        handled.push(event.id);
      }
      result.eventsExamined = handled.length;
      if (handled.length > 0) {
        await tx.update(domainEvents).set({ automationProcessedAt: now }).where(and(eq(domainEvents.organizationId, organizationId), inArray(domainEvents.id, handled)));
      }
    }

    // ---- condition scans ---------------------------------------------------------------------------------------------
    for (const rule of parsed) {
      const spec = rule.spec;
      if (!isScanTrigger(spec.trigger)) continue;
      if (orgPass >= MAX_ORG_RUNS_PER_PASS) {
        result.capped = true;
        break;
      }
      let found: ScanCandidate[] = [];
      if (spec.trigger === "INVOICE_OVERDUE") found = await scanOverdueInvoices(tx, organizationId, rule.row.id, spec.triggerParams.days ?? 1, spec.conditions, now);
      else if (spec.trigger === "BILL_DUE_SOON") found = await scanBillsDueSoon(tx, organizationId, rule.row.id, spec.triggerParams.days ?? 1, spec.conditions, now);
      else {
        result.rearmed += await rearmReorderJobs(tx, organizationId, rule.row.id, spec.action.type === "CREATE_DRAFT_PURCHASE_ORDER");
        found = await scanBelowReorder(tx, organizationId, rule.row.id, spec.conditions, now);
      }
      for (const candidate of found) {
        const verdict = take(rule.row.id);
        if (verdict === "ok") fresh.push({ rule, jobKey: candidate.jobKey, context: candidate.context });
        else {
          // Scans simply wait: nothing is recorded, the row is found again by a later pass once the cap allows.
          result.capped = true;
          break;
        }
      }
    }

    // ---- claim ---------------------------------------------------------------------------------------------------------
    const jobs: PlannedJob[] = [];
    const lease = new Date(now.getTime() + JOB_LEASE_MS);
    if (fresh.length > 0) {
      const inserted = await tx
        .insert(automationJobs)
        .values(fresh.map((c) => ({ id: randomUUID(), organizationId, ruleId: c.rule.row.id, jobKey: c.jobKey, state: "CLAIMED" as const, leaseUntil: lease, context: c.context, createdAt: now, updatedAt: now })))
        .onConflictDoNothing()
        .returning({ id: automationJobs.id, ruleId: automationJobs.ruleId, jobKey: automationJobs.jobKey });
      const claimed = new Map(inserted.map((r) => [`${r.ruleId}|${r.jobKey}`, r.id]));
      for (const candidate of fresh) {
        const jobId = claimed.get(`${candidate.rule.row.id}|${candidate.jobKey}`);
        if (jobId) jobs.push({ jobId, rule: candidate.rule, jobKey: candidate.jobKey, context: candidate.context, attemptsMade: 0 });
      }
    }
    if (capSkipped.length > 0) {
      const inserted = await tx
        .insert(automationJobs)
        .values(capSkipped.map((c) => ({ id: randomUUID(), organizationId, ruleId: c.rule.row.id, jobKey: c.jobKey, state: "SKIPPED" as const, context: c.context, lastError: "Daily limit for automation runs reached.", createdAt: now, updatedAt: now })))
        .onConflictDoNothing()
        .returning({ ruleId: automationJobs.ruleId, jobKey: automationJobs.jobKey });
      const wrote = new Set(inserted.map((r) => `${r.ruleId}|${r.jobKey}`));
      const runRows = capSkipped.filter((c) => wrote.has(`${c.rule.row.id}|${c.jobKey}`));
      if (runRows.length > 0) {
        await tx.insert(automationRuns).values(
          runRows.map((c) => ({
            organizationId,
            ruleId: c.rule.row.id,
            ruleName: c.rule.row.name,
            trigger: c.rule.row.trigger,
            jobKey: c.jobKey,
            attempt: 1,
            outcome: "SKIPPED" as const,
            reason: "Daily limit for automation runs reached; this item was not processed.",
            actorType: "AUTOMATION",
            actorUserId: c.rule.row.authorisedByUserId,
            source,
            startedAt: now,
            finishedAt: now,
          })),
        );
        result.skippedRuns += runRows.length;
      }
    }

    // ---- retries and interrupted jobs ------------------------------------------------------------------------------
    const ruleById = new Map(parsed.map((r) => [r.row.id, r]));
    if (orgPass < MAX_ORG_RUNS_PER_PASS) {
      const due = await tx
        .select({ id: automationJobs.id, ruleId: automationJobs.ruleId, jobKey: automationJobs.jobKey, state: automationJobs.state, attempts: automationJobs.attempts, context: automationJobs.context })
        .from(automationJobs)
        .where(
          and(
            eq(automationJobs.organizationId, organizationId),
            sql`((${automationJobs.state} = 'RETRY' AND ${automationJobs.nextAttemptAt} <= ${now}) OR (${automationJobs.state} = 'CLAIMED' AND ${automationJobs.leaseUntil} < ${now}))`,
          ),
        )
        .orderBy(asc(automationJobs.updatedAt), asc(automationJobs.id))
        .limit(STALE_BATCH)
        .for("update", { skipLocked: true });
      const reclaim: PlannedJob[] = [];
      for (const job of due) {
        const rule = ruleById.get(job.ruleId);
        const context = parseJobContext(job.context);
        if (!rule || !context) continue;
        const planned: PlannedJob = { jobId: job.id, rule, jobKey: job.jobKey, context, attemptsMade: job.attempts };
        if (job.state === "CLAIMED" && rule.spec.action.type !== "SEND_TO_CHANNEL") {
          // An interrupted run of an action that changes something here is never repeated blindly (it may have taken effect).
          await finishIn(tx, planned, { outcome: "FAILED", reason: "Interrupted before it was recorded. It was not repeated, to avoid doing it twice." }, { source, startedAt: now, now });
          result.failed += 1;
          continue;
        }
        if (orgPass >= MAX_ORG_RUNS_PER_PASS) {
          result.capped = true;
          break;
        }
        orgPass += 1;
        reclaim.push(planned);
      }
      if (reclaim.length > 0) {
        await tx
          .update(automationJobs)
          .set({ state: "CLAIMED", leaseUntil: lease, updatedAt: now })
          .where(and(eq(automationJobs.organizationId, organizationId), inArray(automationJobs.id, reclaim.map((j) => j.jobId))));
        jobs.push(...reclaim);
      }
    }

    // ---- retention: old event-keyed dedupe rows (scan keys are never purged - they ARE the "already fired" memory) -------
    if (!lastPurgeAt.has(organizationId) || now.getTime() - (lastPurgeAt.get(organizationId) as number) > PURGE_INTERVAL_MS) {
      lastPurgeAt.set(organizationId, now.getTime());
      const cutoff = new Date(now.getTime() - AUTOMATION_RETENTION_DAYS * 86_400_000);
      await tx.execute(sql`
        DELETE FROM automation_jobs WHERE id IN (
          SELECT id FROM automation_jobs
          WHERE organization_id = ${organizationId} AND job_key LIKE 'event:%' AND state IN ('DONE', 'SKIPPED', 'FAILED') AND created_at < ${cutoff}
          LIMIT 200)`);
    }

    result.claimed = jobs.length;
    return { result, info, jobs };
  });
}

export const AutomationEngine = {
  /**
   * Evaluates ONE organization once. Safe to call concurrently and repeatedly (the dedupe table makes it idempotent and the
   * advisory lock makes a concurrent call return `busy`). Never throws for a rule's failure.
   */
  async runPass(organizationId: string, options: { source: PassSource }, deps: PassDeps = {}): Promise<PassResult> {
    const planned = await plan(organizationId, options.source, deps);
    const result = planned.result;
    if (!planned.info) return result;
    const env = {
      org: planned.info,
      source: options.source,
      deps,
      onOutcome: (outcome: "SUCCESS" | "SKIPPED" | "FAILED") => {
        if (outcome === "SUCCESS") result.succeeded += 1;
        else if (outcome === "SKIPPED") result.skippedRuns += 1;
        else result.failed += 1;
      },
    };
    for (const job of planned.jobs) await executeJob(job, env);
    return result;
  },

  /** "Run automations now": a person with `automation:manage` triggers one bounded pass for their organization. */
  async runNow(actor: Actor, deps: PassDeps = {}): Promise<PassResult> {
    assertHumanAutomationManager(actor);
    return this.runPass(actor.organizationId, { source: "MANUAL" }, deps);
  },
};

export type { PassResult };
