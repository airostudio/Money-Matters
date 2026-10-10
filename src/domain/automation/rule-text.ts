import { ACTION_INFO, OPERATOR_LABELS, TRIGGER_FIELDS, TRIGGER_INFO, type Condition, type RuleSpec, type Trigger } from "./vocabulary";

/**
 * Plain-English rendering of a rule: "WHEN an invoice is created AND Total is greater than 100 THEN notify OWNER". Built
 * only from the closed vocabulary's own labels and the rule's literal values; nothing here is evaluated.
 */
export function describeCondition(trigger: Trigger, condition: Condition): string {
  const def = Object.prototype.hasOwnProperty.call(TRIGGER_FIELDS[trigger], condition.field) ? TRIGGER_FIELDS[trigger][condition.field] : undefined;
  const label = def?.label ?? condition.field;
  const value = Array.isArray(condition.value) ? condition.value.join(", ") : String(condition.value);
  return `${label} ${OPERATOR_LABELS[condition.operator]} ${value}`;
}

export function describeTrigger(trigger: Trigger, params: { days?: number }): string {
  const info = TRIGGER_INFO[trigger];
  if (trigger === "INVOICE_OVERDUE") return `an invoice is ${params.days ?? "N"} or more days overdue`;
  if (trigger === "BILL_DUE_SOON") return `a bill is due within ${params.days ?? "N"} days`;
  return info.label.charAt(0).toLowerCase() + info.label.slice(1);
}

export function describeAction(spec: Pick<RuleSpec, "action">): string {
  const action = spec.action;
  switch (action.type) {
    case "NOTIFY_IN_APP": {
      const who = [...action.roles, ...(action.userIds.length > 0 ? [`${action.userIds.length} named ${action.userIds.length === 1 ? "person" : "people"}`] : [])];
      return `notify ${who.join(", ")} in the app`;
    }
    case "SEND_TO_CHANNEL":
      return "send a message to a connected channel";
    case "EMIT_WEBHOOK_EVENT":
      return "emit an automation.triggered webhook event";
    case "CREATE_DRAFT_PURCHASE_ORDER":
      return ACTION_INFO.CREATE_DRAFT_PURCHASE_ORDER.label.toLowerCase();
  }
}

export function describeRule(spec: Pick<RuleSpec, "trigger" | "triggerParams" | "conditions" | "action">): string {
  const parts = [`WHEN ${describeTrigger(spec.trigger, spec.triggerParams)}`];
  for (const condition of spec.conditions) parts.push(`AND ${describeCondition(spec.trigger, condition)}`);
  parts.push(`THEN ${describeAction(spec)}`);
  return parts.join(" ");
}
