import { and, asc, eq } from "drizzle-orm";
import { automationJobs, automationRules, automationRuns, notifications } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { PassDeps } from "@/domain/automation/engine-types";
import { AutomationRuleService, type RuleInput } from "@/domain/automation/rule-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { TEST_ENCRYPTION_KEY, fakeResolver, fakeTransport } from "./webhooks";

/** A rule input with sensible defaults: notify OWNERs when an invoice is created. */
export function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    name: "Test rule",
    trigger: "invoice.created",
    conditions: [],
    action: { type: "NOTIFY_IN_APP", roles: ["OWNER"], userIds: [], severity: "INFO", includeAmounts: false },
    ...overrides,
  };
}

export async function makeRule(owner: Actor, overrides: Partial<RuleInput> = {}): Promise<string> {
  const { id } = await AutomationRuleService.create(owner, ruleInput(overrides));
  return id;
}

/** Pass dependencies for offline tests: fake DNS, a fake HTTP client, a known key and a fixed link origin. */
export function passDeps(extra: Partial<PassDeps> = {}): PassDeps & { transport: ReturnType<typeof fakeTransport>; resolver: ReturnType<typeof fakeResolver> } {
  return {
    resolver: fakeResolver(),
    transport: fakeTransport(),
    env: { WEBHOOK_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
    baseUrl: "https://app.example.test",
    ...extra,
  } as PassDeps & { transport: ReturnType<typeof fakeTransport>; resolver: ReturnType<typeof fakeResolver> };
}

export const jobsOf = (organizationId: string, ruleId?: string) =>
  withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(automationJobs)
      .where(ruleId ? and(eq(automationJobs.organizationId, organizationId), eq(automationJobs.ruleId, ruleId)) : eq(automationJobs.organizationId, organizationId))
      .orderBy(asc(automationJobs.createdAt), asc(automationJobs.jobKey)),
  );

export const runsOf = (organizationId: string, ruleId?: string) =>
  withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(automationRuns)
      .where(ruleId ? and(eq(automationRuns.organizationId, organizationId), eq(automationRuns.ruleId, ruleId)) : eq(automationRuns.organizationId, organizationId))
      .orderBy(asc(automationRuns.createdAt), asc(automationRuns.id)),
  );

export const ruleRow = async (organizationId: string, ruleId: string) =>
  withTenant(organizationId, async (tx) => {
    const [row] = await tx.select().from(automationRules).where(and(eq(automationRules.organizationId, organizationId), eq(automationRules.id, ruleId)));
    return row!;
  });

export const notificationsOf = (organizationId: string, userId?: string) =>
  withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(userId ? and(eq(notifications.organizationId, organizationId), eq(notifications.recipientUserId, userId)) : eq(notifications.organizationId, organizationId))
      .orderBy(asc(notifications.createdAt), asc(notifications.id)),
  );
