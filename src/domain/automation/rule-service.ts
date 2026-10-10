import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { automationRules, automationRuns, automationSettings, integrationConnections, organizationMemberships, users } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { getProvider } from "@/domain/integrations/registry";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { assertHumanAutomationManager } from "./guards";
import { resolveExecutionIdentity } from "./identity";
import { describeRule } from "./rule-text";
import { ACTION_INFO, MAX_RULES_PER_ORG, validateRuleSpec, type RuleAction, type RuleIssue, type RuleSpec } from "./vocabulary";

/**
 * Management of automation rules - the human side of the Automation Centre (docs/security.md section 18).
 *
 * Creating, editing or enabling a rule IS the person's explicit approval of that narrow action (master spec s.76), so it
 * needs `automation:manage` (OWNER / ADMINISTRATOR) AND a HUMAN actor, and a write-type action (a draft purchase order)
 * additionally needs an explicit acknowledgement that the server checks. Every mutation is audited in its own
 * transaction. A rule is never silently deleted: when it stops running (its authoriser left, it failed repeatedly, a
 * person paused it) it stays, switched off, with the reason showing.
 */
export class InvalidRuleError extends Error {
  constructor(
    message: string,
    public readonly issues: RuleIssue[] = [],
  ) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

export class RuleNotFoundError extends Error {
  constructor() {
    super("Automation rule not found in this organization.");
    this.name = "RuleNotFoundError";
  }
}

export interface RuleView {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  summary: string;
  /** False when the stored JSON no longer passes validation (the engine will switch the rule off on its next pass). */
  valid: boolean;
  spec: RuleSpec | null;
  enabled: boolean;
  disabledCode: string | null;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByName: string | null;
  authorisedByName: string | null;
  authorisedByUserId: string;
  /** Whether the person the rule runs on behalf of is still an active member who can manage automations (live, for the warning banner). */
  authoriserOk: boolean;
  /** A warning the page shows while the rule is still enabled but will be switched off by the next run (the authoriser has gone). */
  authoriserProblem: string | null;
  writesData: boolean;
}

export interface RunView {
  id: string;
  ruleId: string | null;
  ruleName: string;
  trigger: string;
  jobKey: string;
  attempt: number;
  outcome: "SUCCESS" | "SKIPPED" | "FAILED";
  reason: string | null;
  source: string;
  startedAt: Date;
  createdObjectType: string | null;
  createdObjectId: string | null;
}

export interface RuleInput {
  name: string;
  description?: string | null;
  trigger: string;
  triggerParams?: unknown;
  conditions?: unknown;
  action: unknown;
  /** Must be true for an action that writes data (a draft purchase order): the person has read the warning. */
  acknowledgeWriteAction?: boolean;
}

function validate(input: RuleInput): RuleSpec {
  const checked = validateRuleSpec({ name: input.name, description: input.description, trigger: input.trigger, triggerParams: input.triggerParams, conditions: input.conditions ?? [], action: input.action });
  if (!checked.ok) throw new InvalidRuleError(checked.issues[0]?.message ?? "The rule is not valid.", checked.issues);
  if (ACTION_INFO[checked.spec.action.type].writes && input.acknowledgeWriteAction !== true) {
    throw new InvalidRuleError(`"${ACTION_INFO[checked.spec.action.type].label}" creates a record in your books. Confirm that you understand this rule will act without anyone clicking.`, [{ path: "acknowledgeWriteAction", message: "Tick the box to confirm." }]);
  }
  return checked.spec;
}

/** References a rule names must exist in THIS organization: channel connections and named people. */
async function assertReferences(tx: TenantDb, organizationId: string, action: RuleAction): Promise<void> {
  if (action.type === "SEND_TO_CHANNEL") {
    const [connection] = await tx
      .select({ providerId: integrationConnections.providerId, status: integrationConnections.status })
      .from(integrationConnections)
      .where(and(eq(integrationConnections.id, action.connectionId), eq(integrationConnections.organizationId, organizationId)));
    if (!connection) throw new InvalidRuleError("Choose a channel that is connected in this organization.", [{ path: "action.connectionId", message: "Unknown channel." }]);
    if (!getProvider(connection.providerId)?.capabilities.includes("send")) throw new InvalidRuleError("That integration cannot send messages.", [{ path: "action.connectionId", message: "Cannot send." }]);
    if (connection.status !== "CONNECTED") throw new InvalidRuleError("That channel is not connected right now. Reconnect it first.", [{ path: "action.connectionId", message: "Not connected." }]);
  }
  if (action.type === "NOTIFY_IN_APP" && action.userIds.length > 0) {
    const members = await tx
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true), inArray(organizationMemberships.userId, action.userIds)));
    if (members.length !== new Set(action.userIds).size) throw new InvalidRuleError("Every named person must be an active member of this organization.", [{ path: "action.userIds", message: "Unknown person." }]);
  }
}

function assertActorMayAuthorise(actor: Actor, organizationId: string, spec: RuleSpec): void {
  // A person can only approve what they could do themselves: the identity check is the same one the engine applies on every run.
  const identity = resolveExecutionIdentity(
    { id: "pending", name: spec.name, organizationId, trigger: spec.trigger, actionType: spec.action.type },
    { userId: actor.userId, role: actor.role, membershipActive: true, userDisabledAt: null },
  );
  if (!identity.ok) throw new InvalidRuleError(identity.reason);
}

type RuleRow = typeof automationRules.$inferSelect;

function auditView(row: Pick<RuleRow, "name" | "description" | "trigger" | "triggerParams" | "conditions" | "action" | "enabled" | "disabledCode" | "disabledReason">) {
  return { name: row.name, description: row.description, trigger: row.trigger, triggerParams: row.triggerParams, conditions: row.conditions, action: row.action, enabled: row.enabled, disabledCode: row.disabledCode, disabledReason: row.disabledReason };
}

export const AutomationRuleService = {
  async list(actor: Actor): Promise<RuleView[]> {
    assertPermission(actor, "automation:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx.select().from(automationRules).where(eq(automationRules.organizationId, actor.organizationId)).orderBy(desc(automationRules.createdAt), desc(automationRules.id));
      if (rows.length === 0) return [];
      const ids = [...new Set(rows.flatMap((r) => [r.createdByUserId, r.authorisedByUserId]))];
      const people = await tx
        .select({ id: users.id, name: users.name, disabledAt: users.disabledAt, role: organizationMemberships.role, active: organizationMemberships.isActive })
        .from(users)
        .leftJoin(organizationMemberships, and(eq(organizationMemberships.userId, users.id), eq(organizationMemberships.organizationId, actor.organizationId)))
        .where(inArray(users.id, ids));
      const byId = new Map(people.map((p) => [p.id, p]));
      return rows.map((row): RuleView => {
        const checked = validateRuleSpec({ name: row.name, description: row.description, trigger: row.trigger, triggerParams: row.triggerParams, conditions: row.conditions, action: row.action });
        const spec = checked.ok ? checked.spec : null;
        const authoriser = byId.get(row.authorisedByUserId);
        let authoriserProblem: string | null = null;
        if (row.enabled && spec) {
          const identity = resolveExecutionIdentity(
            { id: row.id, name: row.name, organizationId: actor.organizationId, trigger: spec.trigger, actionType: spec.action.type },
            authoriser ? { userId: authoriser.id, role: authoriser.role ?? null, membershipActive: authoriser.active ?? null, userDisabledAt: authoriser.disabledAt } : undefined,
          );
          if (!identity.ok) authoriserProblem = identity.reason.replace(/^Rule disabled: /, "Will be switched off at the next run: ");
        }
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          trigger: row.trigger,
          summary: spec ? describeRule(spec) : "This rule is no longer valid.",
          valid: spec !== null,
          spec,
          enabled: row.enabled,
          disabledCode: row.disabledCode,
          disabledReason: row.disabledReason,
          consecutiveFailures: row.consecutiveFailures,
          lastRunAt: row.lastRunAt,
          lastSuccessAt: row.lastSuccessAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          createdByName: byId.get(row.createdByUserId)?.name ?? null,
          authorisedByName: authoriser?.name ?? null,
          authorisedByUserId: row.authorisedByUserId,
          authoriserOk: authoriserProblem === null,
          authoriserProblem,
          writesData: spec ? ACTION_INFO[spec.action.type].writes : false,
        };
      });
    });
  },

  async create(actor: Actor, input: RuleInput): Promise<{ id: string }> {
    assertHumanAutomationManager(actor);
    const spec = validate(input);
    assertActorMayAuthorise(actor, actor.organizationId, spec);
    return withTenant(actor.organizationId, async (tx) => {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(automationRules).where(eq(automationRules.organizationId, actor.organizationId));
      if (n >= MAX_RULES_PER_ORG) throw new InvalidRuleError(`An organization can have at most ${MAX_RULES_PER_ORG} automation rules. Delete one first.`);
      await assertReferences(tx, actor.organizationId, spec.action);
      const stamp = new Date();
      const [row] = await tx
        .insert(automationRules)
        .values({
          createdAt: stamp,
          updatedAt: stamp,
          organizationId: actor.organizationId,
          name: spec.name,
          description: spec.description,
          trigger: spec.trigger,
          triggerParams: spec.triggerParams,
          conditions: spec.conditions,
          action: spec.action,
          enabled: true,
          createdByUserId: actor.userId,
          authorisedByUserId: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create the rule.");
      await AuditService.record(tx, actor, { action: "automation_rule.created", entityType: "AutomationRule", entityId: row.id, after: auditView(row) });
      return { id: row.id };
    });
  },

  /** Editing is a fresh approval: the editor becomes the authoriser and the rule only reacts to events from now on. It does not switch a disabled rule back on. */
  async update(actor: Actor, ruleId: string, input: RuleInput): Promise<void> {
    assertHumanAutomationManager(actor);
    const spec = validate(input);
    assertActorMayAuthorise(actor, actor.organizationId, spec);
    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new RuleNotFoundError();
      await assertReferences(tx, actor.organizationId, spec.action);
      const [row] = await tx
        .update(automationRules)
        .set({ name: spec.name, description: spec.description, trigger: spec.trigger, triggerParams: spec.triggerParams, conditions: spec.conditions, action: spec.action, authorisedByUserId: actor.userId, updatedAt: new Date() })
        .where(eq(automationRules.id, ruleId))
        .returning();
      if (!row) throw new RuleNotFoundError();
      await AuditService.record(tx, actor, { action: "automation_rule.updated", entityType: "AutomationRule", entityId: ruleId, before: auditView(existing), after: auditView(row) });
    });
  },

  /**
   * Pause (anyone with automation:manage) or enable a rule. Enabling is a fresh approval: the person enabling becomes its
   * authoriser, its failure counter and disabled reason are cleared, and it reacts only to events from now on.
   */
  async setEnabled(actor: Actor, ruleId: string, enabled: boolean, options: { acknowledgeWriteAction?: boolean } = {}): Promise<void> {
    assertHumanAutomationManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new RuleNotFoundError();
      if (enabled) {
        const checked = validateRuleSpec({ name: existing.name, description: existing.description, trigger: existing.trigger, triggerParams: existing.triggerParams, conditions: existing.conditions, action: existing.action });
        if (!checked.ok) throw new InvalidRuleError(`This rule is no longer valid and cannot be switched on: ${checked.issues[0]?.message ?? "invalid"}`, checked.issues);
        if (ACTION_INFO[checked.spec.action.type].writes && options.acknowledgeWriteAction !== true) {
          throw new InvalidRuleError(`"${ACTION_INFO[checked.spec.action.type].label}" creates a record in your books. Confirm that you understand this rule will act without anyone clicking.`, [{ path: "acknowledgeWriteAction", message: "Tick the box to confirm." }]);
        }
        assertActorMayAuthorise(actor, actor.organizationId, checked.spec);
        await assertReferences(tx, actor.organizationId, checked.spec.action);
      }
      const now = new Date();
      const [row] = await tx
        .update(automationRules)
        .set(
          enabled
            ? { enabled: true, disabledCode: null, disabledReason: null, consecutiveFailures: 0, authorisedByUserId: actor.userId, updatedAt: now }
            : { enabled: false, disabledCode: "USER_PAUSED", disabledReason: "Paused by a person.", updatedAt: now },
        )
        .where(eq(automationRules.id, ruleId))
        .returning();
      if (!row) throw new RuleNotFoundError();
      await AuditService.record(tx, actor, { action: enabled ? "automation_rule.enabled" : "automation_rule.paused", entityType: "AutomationRule", entityId: ruleId, before: auditView(existing), after: auditView(row) });
    });
  },

  async remove(actor: Actor, ruleId: string): Promise<void> {
    assertHumanAutomationManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new RuleNotFoundError();
      await tx.delete(automationRules).where(eq(automationRules.id, ruleId));
      await AuditService.record(tx, actor, { action: "automation_rule.deleted", entityType: "AutomationRule", entityId: ruleId, before: auditView(existing) });
    });
  },

  /** The EMERGENCY switch. Takes effect on the very next evaluation pass (the engine reads it every time, uncached). */
  async setAllPaused(actor: Actor, paused: boolean): Promise<void> {
    assertHumanAutomationManager(actor);
    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx.select().from(automationSettings).where(eq(automationSettings.organizationId, actor.organizationId));
      const now = new Date();
      if (existing) {
        await tx
          .update(automationSettings)
          .set(paused ? { allPaused: true, pausedAt: now, pausedByUserId: actor.userId, updatedAt: now } : { allPaused: false, updatedAt: now })
          .where(eq(automationSettings.organizationId, actor.organizationId));
      } else {
        await tx.insert(automationSettings).values({ organizationId: actor.organizationId, allPaused: paused, pausedAt: paused ? now : null, pausedByUserId: paused ? actor.userId : null, updatedAt: now });
      }
      await AuditService.record(tx, actor, {
        action: paused ? "automation.all_paused" : "automation.all_resumed",
        entityType: "AutomationSettings",
        entityId: actor.organizationId,
        before: { allPaused: existing?.allPaused ?? false },
        after: { allPaused: paused },
      });
    });
  },

  async getSettings(actor: Actor): Promise<{ allPaused: boolean; pausedAt: Date | null }> {
    assertPermission(actor, "automation:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx.select().from(automationSettings).where(eq(automationSettings.organizationId, actor.organizationId));
      return { allPaused: row?.allPaused ?? false, pausedAt: row?.pausedAt ?? null };
    });
  },

  async listRuns(actor: Actor, options: { limit?: number; ruleId?: string } = {}): Promise<RunView[]> {
    assertPermission(actor, "automation:read");
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select({
          id: automationRuns.id,
          ruleId: automationRuns.ruleId,
          ruleName: automationRuns.ruleName,
          trigger: automationRuns.trigger,
          jobKey: automationRuns.jobKey,
          attempt: automationRuns.attempt,
          outcome: automationRuns.outcome,
          reason: automationRuns.reason,
          source: automationRuns.source,
          startedAt: automationRuns.startedAt,
          createdObjectType: automationRuns.createdObjectType,
          createdObjectId: automationRuns.createdObjectId,
        })
        .from(automationRuns)
        .where(options.ruleId ? and(eq(automationRuns.organizationId, actor.organizationId), eq(automationRuns.ruleId, options.ruleId)) : eq(automationRuns.organizationId, actor.organizationId))
        .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
        .limit(limit),
    );
  },
};
