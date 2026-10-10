import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ROLES_BY_PRIVILEGE, ROLE_LABELS } from "@/domain/permissions/role-info";
import { AutomationRuleService } from "@/domain/automation/rule-service";
import { IntegrationService } from "@/domain/integrations/connection-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { integrationEncryptionStatus } from "@/domain/integrations/connection-service";
import {
  ACTION_INFO,
  ACTION_TRIGGERS,
  ACTION_TYPES,
  DUE_SOON_DAYS_RANGE,
  MAX_CONDITIONS,
  MAX_ORG_RUNS_PER_DAY,
  MAX_ORG_RUNS_PER_PASS,
  MAX_RULES_PER_ORG,
  MAX_RULE_RUNS_PER_DAY,
  MAX_RULE_RUNS_PER_PASS,
  OPERATOR_LABELS,
  OVERDUE_DAYS_RANGE,
  AUTO_DISABLE_AFTER_FAILURES,
  TRIGGERS,
  TRIGGER_FIELDS,
  TRIGGER_INFO,
  operatorsForKind,
} from "@/domain/automation/vocabulary";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AutomationRuleForm, type RuleFormConfig } from "@/components/shell/automation-rule-form";
import { createRuleAction, deleteRuleAction, runNowAction, setAllPausedAction, setRuleEnabledAction } from "./actions";
import { noticeText } from "./notices";

function formatTime(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "never";
}

const OUTCOME_STYLES = { SUCCESS: "bg-success/15 text-success", SKIPPED: "bg-muted text-muted-foreground", FAILED: "bg-destructive/10 text-destructive" } as const;

/**
 * The Automation Centre (Phase 10 Slice 3, master spec s.75). Rules are { trigger, conditions, action } from CLOSED lists;
 * every action is low-risk and reversible; a rule runs with the permissions of the person who approved it or less. There is
 * no background scheduler: automations run when you press "Run automations now", shortly after a change in the books, and
 * whenever webhook events are sent.
 */
export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { notice?: string; ok?: string; failed?: string; skipped?: string; more?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "automation:read")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Automation</h1>
        <p className="text-sm text-muted-foreground">Your role in {org.name} does not include automations.</p>
      </div>
    );
  }
  const canManage = roleHasPermission(actor.role, "automation:manage");

  // Sequential on purpose (DB connection discipline): each call is one short transaction.
  const rules = await AutomationRuleService.list(actor);
  const settings = await AutomationRuleService.getSettings(actor);
  const runs = await AutomationRuleService.listRuns(actor, { limit: 30 });
  const channels = await IntegrationService.listSendTargets(actor);
  const people = canManage && roleHasPermission(actor.role, "contact:read") ? await ContactService.list(actor) : [];
  const encryption = integrationEncryptionStatus();
  const notice = noticeText(searchParams);

  const customers = people.filter((c) => c.kind === "CUSTOMER" || c.kind === "BOTH").slice(0, 200).map((c) => ({ value: c.id, label: c.displayName }));
  const suppliers = people.filter((c) => c.kind === "SUPPLIER" || c.kind === "BOTH").slice(0, 200).map((c) => ({ value: c.id, label: c.displayName }));

  const formConfig: RuleFormConfig = {
    maxConditions: MAX_CONDITIONS,
    roles: ROLES_BY_PRIVILEGE.filter((r) => r !== "EMPLOYEE").map((r) => ({ value: r, label: ROLE_LABELS[r] })).reverse(),
    channels: channels.map((c) => ({ id: c.id, name: c.name, providerName: c.providerName, status: c.status })),
    actions: ACTION_TYPES.map((t) => ({ type: t, label: ACTION_INFO[t].label, description: ACTION_INFO[t].description, reversibleBy: ACTION_INFO[t].reversibleBy, writes: ACTION_INFO[t].writes })),
    triggers: TRIGGERS.map((t) => ({
      id: t,
      label: TRIGGER_INFO[t].label,
      description: TRIGGER_INFO[t].description,
      days:
        t === "INVOICE_OVERDUE"
          ? { label: "Days past due", ...OVERDUE_DAYS_RANGE, default: 7 }
          : t === "BILL_DUE_SOON"
            ? { label: "Due within (days)", ...DUE_SOON_DAYS_RANGE, default: 7 }
            : null,
      actions: ACTION_TYPES.filter((a) => ACTION_TRIGGERS[a].includes(t)),
      fields: Object.entries(TRIGGER_FIELDS[t]).map(([name, def]) => ({
        name,
        label: def.label,
        kind: def.kind,
        values: def.values ? [...def.values] : undefined,
        choices: name === "customer_id" ? customers : name === "supplier_id" ? suppliers : undefined,
        operators: operatorsForKind(def.kind).map((o) => ({ value: o, label: OPERATOR_LABELS[o] })),
      })),
    })),
  };

  const boundCreate = createRuleAction.bind(null, org.slug);
  const boundEnable = setRuleEnabledAction.bind(null, org.slug);
  const boundDelete = deleteRuleAction.bind(null, org.slug);
  const boundPause = setAllPausedAction.bind(null, org.slug);
  const boundRun = runNowAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Automation</h1>
        <p className="text-sm text-muted-foreground">
          Rules of the form <strong>WHEN</strong> something happens <strong>AND</strong> conditions hold <strong>THEN</strong> a safe action runs. Actions are limited to notifying people, sending a short channel message, emitting a webhook event, and
          drafting a purchase order that you review - automations can never post, approve, void, pay, close a period or change who has access. Every run is logged, and you can pause one rule or everything at any time.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          There is no background scheduler: rules run when you press <em>Run automations now</em>, shortly after a change in the books, and whenever webhook events are sent.
        </p>
      </div>

      {settings.allPaused && (
        <p role="alert" data-testid="automation-paused-banner" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <span className="font-medium">All automations are paused</span>
          {settings.pausedAt ? ` since ${formatTime(settings.pausedAt)}` : ""}. Nothing runs, from any source, until you resume them. Events that happen while paused are not replayed afterwards.
        </p>
      )}
      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15"}`}>
          {notice.text}
        </p>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
          <div>
            <p className="font-medium">Run now, or stop everything</p>
            <p className="text-xs text-muted-foreground">
              Per pass: at most {MAX_RULE_RUNS_PER_PASS} runs per rule and {MAX_ORG_RUNS_PER_PASS} in total; per day: {MAX_RULE_RUNS_PER_DAY} per rule and {MAX_ORG_RUNS_PER_DAY} in total. A rule that fails {AUTO_DISABLE_AFTER_FAILURES} times in a
              row is switched off.
            </p>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <form action={boundRun}>
                <Button type="submit" size="sm" disabled={settings.allPaused}>
                  Run automations now
                </Button>
              </form>
              <form action={boundPause}>
                <input type="hidden" name="paused" value={settings.allPaused ? "false" : "true"} />
                <Button type="submit" size="sm" variant={settings.allPaused ? "default" : "destructive"} data-testid="pause-all">
                  {settings.allPaused ? "Resume all automations" : "Pause all automations"}
                </Button>
              </form>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only an Owner or Administrator can run or pause automations.</p>
          )}
        </CardContent>
      </Card>

      <Card data-testid="autonomy-pointer">
        <CardHeader>
          <CardTitle className="text-base">Auto-reconciling bank matches</CardTitle>
          <CardDescription>
            &quot;When bank confidence is above 99% and the rule is approved, reconcile automatically&quot; already exists as an approved automatic action of the AI Financial Controller (<code>BANK_RECONCILIATION_AUTO_MATCH</code>). It is
            switched on per action type in{" "}
            <Link href={`/${org.slug}/settings`} className="text-primary underline">
              Settings, AI Financial Controller autonomy
            </Link>
            , not here, so there is one mechanism with one set of safeguards.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your rules</CardTitle>
          <CardDescription>
            {rules.length} of {MAX_RULES_PER_ORG}. A rule runs as the person who last approved it, with that person&apos;s current permissions or fewer.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rules.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="rule-list">
              {rules.map((r) => (
                <li key={r.id} className="space-y-2 px-6 py-4 text-sm" data-testid="rule-item">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">
                        {r.name}{" "}
                        <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${r.enabled ? "bg-success/15 text-success" : r.disabledCode === "USER_PAUSED" ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"}`}>
                          {r.enabled ? "ON" : r.disabledCode === "USER_PAUSED" ? "PAUSED" : "SWITCHED OFF"}
                        </span>
                        {r.writesData && <span className="ml-1 rounded bg-warning/20 px-1.5 py-0.5 text-xs font-medium">writes drafts</span>}
                      </p>
                      <p className="text-muted-foreground">{r.summary}</p>
                      {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                      {!r.enabled && r.disabledReason && (
                        <p role="note" className="text-xs text-destructive" data-testid="rule-disabled-reason">
                          {r.disabledReason}
                        </p>
                      )}
                      {r.authoriserProblem && (
                        <p role="alert" className="text-xs text-destructive" data-testid="rule-authoriser-problem">
                          {r.authoriserProblem}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Authorised by {r.authorisedByName ?? "an unknown user"}
                        {r.createdByName && r.createdByName !== r.authorisedByName ? ` (created by ${r.createdByName})` : ""} - last run {formatTime(r.lastRunAt)} - last success {formatTime(r.lastSuccessAt)}
                        {r.consecutiveFailures > 0 ? ` - ${r.consecutiveFailures} failure(s) in a row` : ""}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={boundEnable} className="flex items-center gap-2">
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
                          {!r.enabled && r.writesData && (
                            <label className="flex items-center gap-1 text-xs">
                              <input type="checkbox" name="acknowledgeWriteAction" required /> I approve it creating drafts
                            </label>
                          )}
                          <Button type="submit" size="sm" variant="secondary">
                            {r.enabled ? "Pause" : "Switch on"}
                          </Button>
                        </form>
                        <form action={boundDelete}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <Button type="submit" size="sm" variant="destructive">
                            Delete
                          </Button>
                        </form>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage && rules.length < MAX_RULES_PER_ORG && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a rule</CardTitle>
            <CardDescription>Everything you can choose is from a fixed list. You cannot write code, formulas or queries here.</CardDescription>
          </CardHeader>
          <CardContent>
            <AutomationRuleForm action={boundCreate} config={formConfig} />
            {!encryption.configured && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="channels-unavailable">
                Sending to a channel needs the platform operator to set the encryption key for integration credentials ({encryption.reason}). Notifications, webhook events and draft purchase orders are unaffected.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run log</CardTitle>
          <CardDescription>The latest {runs.length} runs, newest first. The log is append-only: it cannot be edited or erased.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing has run yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="run-log">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-start justify-between gap-2 px-6 py-3 text-sm">
                  <div className="min-w-0 space-y-0.5">
                    <p>
                      <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-medium ${OUTCOME_STYLES[run.outcome]}`}>{run.outcome}</span>
                      <span className="font-medium">{run.ruleName}</span> <span className="text-xs text-muted-foreground">attempt {run.attempt} - {run.source.toLowerCase().replace("_", " ")}</span>
                    </p>
                    {run.reason && <p className="text-xs text-muted-foreground">{run.reason}</p>}
                    {run.createdObjectType === "PurchaseOrder" && run.createdObjectId && (
                      <p className="text-xs">
                        Created{" "}
                        <Link href={`/${org.slug}/purchases/purchase-orders/${run.createdObjectId}`} className="text-primary underline">
                          draft purchase order
                        </Link>{" "}
                        (review it, edit it, or delete it)
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatTime(run.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="deferred-examples">
        <CardHeader>
          <CardTitle className="text-base">What is not available yet, and why</CardTitle>
          <CardDescription>The spec&apos;s examples that this version deliberately does not offer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">&quot;Expense over $2,000 then request CFO approval&quot;</strong> - there is no multi-level approval engine yet, and an automation may never approve or route approvals itself.
          </p>
          <p>
            <strong className="text-foreground">&quot;Supplier bank details change then block payment and alert the owner&quot;</strong> - there is no event for a supplier&apos;s bank details changing, and blocking a payment is a
            human-controlled action.
          </p>
          <p>
            <strong className="text-foreground">&quot;Monthly close reaches 100% then prepare the management pack&quot;</strong> - the close checklist is expensive to compute, so it cannot be evaluated on every pass. Month-end close itself stays a
            human decision.
          </p>
          <p>
            <strong className="text-foreground">Email and SMS reminders</strong> - there is no email or SMS service. For &quot;send a reminder when an invoice is 7 days overdue&quot;, use the overdue trigger with a notification or a channel message.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
