import Decimal from "decimal.js";
import { z } from "zod";
import { ROLES_BY_PRIVILEGE } from "@/domain/permissions/role-info";
import { PERMISSIONS, type Permission } from "@/domain/permissions/roles";

/**
 * THE CLOSED VOCABULARY of the Automation Centre (master spec s.75; docs/security.md section 18).
 *
 * A rule is `{ trigger, triggerParams, conditions[], action }` and nothing else. Every part comes from a closed list
 * defined in THIS file:
 *   - the trigger is one of `TRIGGERS`;
 *   - a condition is `{ field, operator, value }` where `field` must be in that trigger's fixed whitelist (`TRIGGER_FIELDS`),
 *     `operator` in a small closed list that makes sense for the field's kind, and `value` a plain literal checked against
 *     the field's kind (a decimal STRING for money and quantities - never a float - an integer, a uuid, a member of a fixed
 *     list). A condition is DATA: it is compared, never parsed, never evaluated. There is no expression language, no
 *     `eval`/`Function`, no SQL fragment and no template substitution anywhere in this module;
 *   - the action is one of `ACTION_TYPES`: a closed set of LOW-RISK, REVERSIBLE actions. Posting, approving, voiding,
 *     payments, payment runs, bank-detail changes, payroll, journals, period close/lock, membership/role/seat changes,
 *     API-key / webhook / integration management and AI autonomy settings are NOT in it and cannot be expressed.
 *
 * The same validation runs at creation AND again on every run (a stored row is not trusted), so a row edited or written
 * around the service is refused at evaluation time.
 */

// ---- Triggers ---------------------------------------------------------------------------------------------------------

/** Event-driven triggers: the outbox events of Phase 10 Slice 2 (`automation.triggered` is deliberately NOT one - loop protection). */
export const EVENT_TRIGGERS = [
  "customer.created",
  "supplier.created",
  "invoice.created",
  "invoice.sent",
  "invoice.paid",
  "payment.received",
  "bill.created",
  "bill.approved",
] as const;

/** Condition-scan triggers: deterministic, bounded SQL scans run during an evaluation pass. */
export const SCAN_TRIGGERS = ["INVOICE_OVERDUE", "BILL_DUE_SOON", "INVENTORY_BELOW_REORDER"] as const;

export const TRIGGERS = [...EVENT_TRIGGERS, ...SCAN_TRIGGERS] as const;

export type EventTrigger = (typeof EVENT_TRIGGERS)[number];
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];
export type Trigger = (typeof TRIGGERS)[number];

export function isEventTrigger(trigger: string): trigger is EventTrigger {
  return (EVENT_TRIGGERS as readonly string[]).includes(trigger);
}
export function isScanTrigger(trigger: string): trigger is ScanTrigger {
  return (SCAN_TRIGGERS as readonly string[]).includes(trigger);
}

export const TRIGGER_INFO: Record<Trigger, { label: string; description: string; kind: "event" | "scan"; object: "Invoice" | "Bill" | "Payment" | "Contact" | "Product" }> = {
  "customer.created": { label: "A customer is added", description: "Fires once for each new customer.", kind: "event", object: "Contact" },
  "supplier.created": { label: "A supplier is added", description: "Fires once for each new supplier.", kind: "event", object: "Contact" },
  "invoice.created": { label: "An invoice is created", description: "Fires once for each new draft invoice.", kind: "event", object: "Invoice" },
  "invoice.sent": { label: "An invoice is sent", description: "Fires once when an approved invoice is marked as sent.", kind: "event", object: "Invoice" },
  "invoice.paid": { label: "An invoice is paid", description: "Fires once when payments cover an invoice in full.", kind: "event", object: "Invoice" },
  "payment.received": { label: "A customer payment is received", description: "Fires once for each recorded customer payment.", kind: "event", object: "Payment" },
  "bill.created": { label: "A bill is created", description: "Fires once for each new draft bill.", kind: "event", object: "Bill" },
  "bill.approved": { label: "A bill is approved", description: "Fires once when a bill is approved and posted.", kind: "event", object: "Bill" },
  INVOICE_OVERDUE: { label: "An invoice is overdue", description: "Fires once per invoice when it is N days past its due date and still has an amount due.", kind: "scan", object: "Invoice" },
  BILL_DUE_SOON: { label: "A bill is due soon", description: "Fires once per bill when it is due within N days and still has an amount due.", kind: "scan", object: "Bill" },
  INVENTORY_BELOW_REORDER: {
    label: "Stock is at or below its reorder point",
    description: "Fires once per product when its quantity on hand falls to its reorder point; it re-arms when stock recovers above the point.",
    kind: "scan",
    object: "Product",
  },
};

// ---- Conditions -------------------------------------------------------------------------------------------------------

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
};

export type FieldKind = "decimal" | "integer" | "uuid" | "enum" | "currency";

export interface FieldDef {
  label: string;
  kind: FieldKind;
  /** For `enum`: the complete list of accepted values. */
  values?: readonly string[];
}

const OPERATORS_BY_KIND: Record<FieldKind, readonly Operator[]> = {
  decimal: ["eq", "neq", "gt", "gte", "lt", "lte"],
  integer: ["eq", "neq", "gt", "gte", "lt", "lte"],
  uuid: ["eq", "neq", "in"],
  enum: ["eq", "neq", "in"],
  currency: ["eq", "neq", "in"],
};

export function operatorsForKind(kind: FieldKind): readonly Operator[] {
  return OPERATORS_BY_KIND[kind];
}

const MONEY_TOTAL: FieldDef = { label: "Total", kind: "decimal" };
const MONEY_DUE: FieldDef = { label: "Amount due", kind: "decimal" };
const CURRENCY: FieldDef = { label: "Currency", kind: "currency" };

/** The FIXED whitelist of condition fields per trigger. Nothing outside this table can be referenced by a rule. */
export const TRIGGER_FIELDS: Record<Trigger, Record<string, FieldDef>> = {
  "customer.created": { kind: { label: "Contact type", kind: "enum", values: ["CUSTOMER", "BOTH"] }, currency: CURRENCY },
  "supplier.created": { kind: { label: "Contact type", kind: "enum", values: ["SUPPLIER", "BOTH"] }, currency: CURRENCY },
  "invoice.created": { total: MONEY_TOTAL, amount_due: MONEY_DUE, customer_id: { label: "Customer", kind: "uuid" }, currency: CURRENCY },
  "invoice.sent": { total: MONEY_TOTAL, amount_due: MONEY_DUE, customer_id: { label: "Customer", kind: "uuid" }, currency: CURRENCY },
  "invoice.paid": { total: MONEY_TOTAL, amount_due: MONEY_DUE, customer_id: { label: "Customer", kind: "uuid" }, currency: CURRENCY },
  "payment.received": {
    amount: { label: "Payment amount", kind: "decimal" },
    customer_id: { label: "Customer", kind: "uuid" },
    method: { label: "Payment method", kind: "enum", values: ["BANK_TRANSFER", "CASH", "CARD", "CHEQUE", "OTHER"] },
    currency: CURRENCY,
  },
  "bill.created": { total: MONEY_TOTAL, amount_due: MONEY_DUE, supplier_id: { label: "Supplier", kind: "uuid" }, currency: CURRENCY },
  "bill.approved": { total: MONEY_TOTAL, amount_due: MONEY_DUE, supplier_id: { label: "Supplier", kind: "uuid" }, currency: CURRENCY },
  INVOICE_OVERDUE: {
    total: MONEY_TOTAL,
    amount_due: MONEY_DUE,
    days_overdue: { label: "Days overdue", kind: "integer" },
    customer_id: { label: "Customer", kind: "uuid" },
    currency: CURRENCY,
  },
  BILL_DUE_SOON: {
    total: MONEY_TOTAL,
    amount_due: MONEY_DUE,
    days_until_due: { label: "Days until due", kind: "integer" },
    supplier_id: { label: "Supplier", kind: "uuid" },
    currency: CURRENCY,
  },
  INVENTORY_BELOW_REORDER: {
    quantity_on_hand: { label: "Quantity on hand", kind: "decimal" },
    reorder_point: { label: "Reorder point", kind: "decimal" },
    reorder_quantity: { label: "Reorder quantity", kind: "decimal" },
    shortfall: { label: "Shortfall below reorder point", kind: "decimal" },
    supplier_id: { label: "Preferred supplier", kind: "uuid" },
  },
};

const DECIMAL_LITERAL = /^-?\d{1,15}(\.\d{1,4})?$/;
const INTEGER_LITERAL = /^-?\d{1,9}$/;
const UUID_LITERAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_LITERAL = /^[A-Z]{3}$/;
export const MAX_IN_LIST = 10;
export const MAX_CONDITIONS = 5;

export type ConditionValue = string | number | string[];

export interface Condition {
  field: string;
  operator: Operator;
  value: ConditionValue;
}

export const conditionSchema = z
  .object({
    field: z.string().min(1).max(40),
    operator: z.enum(OPERATORS),
    value: z.union([z.string().max(64), z.number().int(), z.array(z.string().max(64)).min(1).max(MAX_IN_LIST)]),
  })
  .strict();

/** Checks one scalar literal against a field kind. Returns the NORMALISED literal, or an error message. */
function checkScalar(def: FieldDef, raw: unknown): { ok: true; value: string | number } | { ok: false; message: string } {
  switch (def.kind) {
    case "decimal":
      // A JS number is refused on purpose: money and quantities are decimal STRINGS (floats cannot represent them).
      if (typeof raw !== "string" || !DECIMAL_LITERAL.test(raw)) return { ok: false, message: `${def.label}: enter a decimal amount as text, for example "2000" or "2000.50" (at most 4 decimal places).` };
      return { ok: true, value: new Decimal(raw).toFixed() };
    case "integer": {
      const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : typeof raw === "string" ? raw : "";
      if (!INTEGER_LITERAL.test(text)) return { ok: false, message: `${def.label}: enter a whole number.` };
      return { ok: true, value: Number(text) };
    }
    case "uuid":
      if (typeof raw !== "string" || !UUID_LITERAL.test(raw)) return { ok: false, message: `${def.label}: choose one of the listed records.` };
      return { ok: true, value: raw.toLowerCase() };
    case "currency":
      if (typeof raw !== "string" || !CURRENCY_LITERAL.test(raw)) return { ok: false, message: `${def.label}: use a three-letter currency code such as AUD.` };
      return { ok: true, value: raw };
    case "enum":
      if (typeof raw !== "string" || !(def.values ?? []).includes(raw)) return { ok: false, message: `${def.label}: choose one of ${(def.values ?? []).join(", ")}.` };
      return { ok: true, value: raw };
  }
}

export interface RuleIssue {
  path: string;
  message: string;
}

/** Validates ONE condition against a trigger's field whitelist. Pure. */
export function validateCondition(trigger: Trigger, input: unknown): { ok: true; condition: Condition } | { ok: false; issues: RuleIssue[] } {
  const parsed = conditionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  const { field, operator, value } = parsed.data;
  const def = Object.prototype.hasOwnProperty.call(TRIGGER_FIELDS[trigger], field) ? TRIGGER_FIELDS[trigger][field] : undefined;
  if (!def) return { ok: false, issues: [{ path: "field", message: `"${field}" is not a field this trigger offers.` }] };
  if (!operatorsForKind(def.kind).includes(operator)) return { ok: false, issues: [{ path: "operator", message: `"${operator}" cannot be used with ${def.label}.` }] };
  if (operator === "in") {
    if (!Array.isArray(value)) return { ok: false, issues: [{ path: "value", message: `${def.label}: "is one of" needs a list.` }] };
    const out: string[] = [];
    for (const item of value) {
      const checked = checkScalar(def, item);
      if (!checked.ok) return { ok: false, issues: [{ path: "value", message: checked.message }] };
      out.push(String(checked.value));
    }
    return { ok: true, condition: { field, operator, value: [...new Set(out)] } };
  }
  if (Array.isArray(value)) return { ok: false, issues: [{ path: "value", message: `${def.label}: this comparison takes a single value.` }] };
  const checked = checkScalar(def, value);
  if (!checked.ok) return { ok: false, issues: [{ path: "value", message: checked.message }] };
  return { ok: true, condition: { field, operator, value: checked.value } };
}

export type FactValue = string | number | null;
export type Facts = Record<string, FactValue>;

/**
 * Compares a fact with a condition. Money and quantities are compared as exact decimals (decimal.js), never as floats; a
 * missing fact never matches (a rule cannot fire on data it could not read). Pure and total: it never throws.
 */
export function evaluateCondition(condition: Condition, facts: Facts, trigger: Trigger): boolean {
  const def = Object.prototype.hasOwnProperty.call(TRIGGER_FIELDS[trigger], condition.field) ? TRIGGER_FIELDS[trigger][condition.field] : undefined;
  if (!def) return false;
  const fact = Object.prototype.hasOwnProperty.call(facts, condition.field) ? facts[condition.field] : null;
  if (fact === null || fact === undefined) return false;
  try {
    if (condition.operator === "in") {
      if (!Array.isArray(condition.value)) return false;
      return condition.value.some((v) => String(v).toLowerCase() === String(fact).toLowerCase());
    }
    if (Array.isArray(condition.value)) return false;
    if (def.kind === "decimal" || def.kind === "integer") {
      const left = new Decimal(String(fact));
      const right = new Decimal(String(condition.value));
      switch (condition.operator) {
        case "eq":
          return left.equals(right);
        case "neq":
          return !left.equals(right);
        case "gt":
          return left.greaterThan(right);
        case "gte":
          return left.greaterThanOrEqualTo(right);
        case "lt":
          return left.lessThan(right);
        case "lte":
          return left.lessThanOrEqualTo(right);
        default:
          return false;
      }
    }
    const left = String(fact).toLowerCase();
    const right = String(condition.value).toLowerCase();
    if (condition.operator === "eq") return left === right;
    if (condition.operator === "neq") return left !== right;
    return false;
  } catch {
    return false;
  }
}

/** All conditions must hold (AND). An empty list always holds. */
export function evaluateConditions(conditions: readonly Condition[], facts: Facts, trigger: Trigger): boolean {
  return conditions.every((c) => evaluateCondition(c, facts, trigger));
}

// ---- Actions ----------------------------------------------------------------------------------------------------------

/** The CLOSED set of automation actions. Every one is low-risk and reversible (a dismissible notification, a message, an outbox event, a deletable DRAFT). */
export const ACTION_TYPES = ["NOTIFY_IN_APP", "SEND_TO_CHANNEL", "EMIT_WEBHOOK_EVENT", "CREATE_DRAFT_PURCHASE_ORDER"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_INFO: Record<ActionType, { label: string; description: string; reversibleBy: string; writes: boolean }> = {
  NOTIFY_IN_APP: { label: "Notify people in the app", description: "Adds a notification for the chosen roles or people.", reversibleBy: "Each person can dismiss it.", writes: false },
  SEND_TO_CHANNEL: { label: "Send a message to a connected channel", description: "Posts a short message to a connected channel such as Slack.", reversibleBy: "A message in a channel can be deleted there; nothing in Money Matters changes.", writes: false },
  EMIT_WEBHOOK_EVENT: { label: "Send an automation.triggered webhook event", description: "Emits an event to your webhook subscriptions that listen for automation.triggered.", reversibleBy: "Nothing in Money Matters changes; your receiving system decides what to do.", writes: false },
  CREATE_DRAFT_PURCHASE_ORDER: {
    label: "Create a DRAFT purchase order",
    description: "Creates a draft purchase order for the product's preferred supplier at its reorder quantity. It is never sent, never converted to a bill and never posted.",
    reversibleBy: "It is a normal draft: review it, edit it, or delete it.",
    writes: true,
  },
};

/** Which triggers each action may be combined with. */
export const ACTION_TRIGGERS: Record<ActionType, readonly Trigger[]> = {
  NOTIFY_IN_APP: TRIGGERS,
  SEND_TO_CHANNEL: TRIGGERS,
  EMIT_WEBHOOK_EVENT: TRIGGERS,
  CREATE_DRAFT_PURCHASE_ORDER: ["INVENTORY_BELOW_REORDER"],
};

export const SEVERITIES = ["INFO", "ACTION", "WARNING", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const MAX_MESSAGE_CHARS = 200;
const plainText = z
  .string()
  .max(MAX_MESSAGE_CHARS)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Control characters are not allowed.");

export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("NOTIFY_IN_APP"),
      roles: z.array(z.enum(ROLES_BY_PRIVILEGE as unknown as [string, ...string[]])).max(10).default([]),
      userIds: z.array(z.string().regex(UUID_LITERAL)).max(10).default([]),
      severity: z.enum(SEVERITIES).default("INFO"),
      message: plainText.optional(),
      includeAmounts: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("SEND_TO_CHANNEL"),
      connectionId: z.string().regex(UUID_LITERAL),
      message: plainText.optional(),
    })
    .strict(),
  z.object({ type: z.literal("EMIT_WEBHOOK_EVENT") }).strict(),
  z.object({ type: z.literal("CREATE_DRAFT_PURCHASE_ORDER") }).strict(),
]).refine((a) => a.type !== "NOTIFY_IN_APP" || a.roles.length + a.userIds.length > 0, {
  message: "Choose at least one role or person to notify.",
  path: ["roles"],
});

export type RuleAction = z.infer<typeof actionSchema>;

// ---- Action -> permission mapping -------------------------------------------------------------------------------------

/**
 * The permissions each action NEEDS. The automation identity's power is this set intersected with the authorising
 * person's CURRENT role (src/domain/automation/identity.ts) - it can only ever be smaller. Notice what is absent: not one
 * `:post`, `:void`, `:approve`, `:reverse`, `:close`, `:reopen`, payment, payroll, journal, membership, api_key, webhook,
 * integration or autonomy permission appears anywhere in this table (a test walks it to prove it).
 */
export const ACTION_PERMISSIONS: Record<ActionType, readonly Permission[]> = {
  NOTIFY_IN_APP: ["automation:read"],
  SEND_TO_CHANNEL: ["automation:read"],
  EMIT_WEBHOOK_EVENT: ["automation:read"],
  CREATE_DRAFT_PURCHASE_ORDER: ["purchase_order:manage", "inventory:read", "product:read", "contact:read"],
};

/** The read permission a person needs to see the object a trigger is about (so a rule never reads or reveals what its authoriser could not). */
export const TRIGGER_READ_PERMISSIONS: Record<Trigger, Permission> = {
  "customer.created": "contact:read",
  "supplier.created": "contact:read",
  "invoice.created": "customer_invoice:read",
  "invoice.sent": "customer_invoice:read",
  "invoice.paid": "customer_invoice:read",
  "payment.received": "customer_payment:read",
  "bill.created": "supplier_bill:read",
  "bill.approved": "supplier_bill:read",
  INVOICE_OVERDUE: "customer_invoice:read",
  BILL_DUE_SOON: "supplier_bill:read",
  INVENTORY_BELOW_REORDER: "inventory:read",
};

/**
 * The ONLY permissions an automation identity may ever carry: plain reads, plus `purchase_order:manage` for the one
 * action that creates a draft. `buildAutomationActor` intersects with this too, so even a future mistake in
 * `ACTION_PERMISSIONS` cannot widen the identity beyond it.
 */
export const AUTOMATION_ALLOWED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "automation:read",
  "contact:read",
  "customer_invoice:read",
  "customer_payment:read",
  "supplier_bill:read",
  "inventory:read",
  "product:read",
  "purchase_order:manage",
]);

/** Permissions that must NEVER be reachable by an automation, by name pattern (used by the exclusion test and by the identity builder). */
export const AUTOMATION_FORBIDDEN_PATTERN =
  /(:post|:void|:approve|:reverse|:close|:reopen|:reopen_hard|:override_soft|:post_advisor_locked|:import|:reconcile|:respond|:ai_suggest)$|^(period|membership|organization|api_key|webhook|integration|approval|automation:manage|employee|payrun|journal|payment_run|supplier_payment|customer_payment:manage|consolidation|tax_code|fiscal_period|account:manage|onboarding|bank_account:manage|bank_rule|expense_claim:approve)/;

export function isForbiddenForAutomation(permission: string): boolean {
  return AUTOMATION_FORBIDDEN_PATTERN.test(permission);
}

/** Every permission an automation could ever be granted, for tests and the UI's plain-language summary. */
export function permissionsRequiredBy(trigger: Trigger, action: ActionType): Permission[] {
  const set = new Set<Permission>([...ACTION_PERMISSIONS[action], TRIGGER_READ_PERMISSIONS[trigger]]);
  return PERMISSIONS.filter((p) => set.has(p));
}

// ---- Trigger parameters -----------------------------------------------------------------------------------------------

export const OVERDUE_DAYS_RANGE = { min: 1, max: 365 } as const;
export const DUE_SOON_DAYS_RANGE = { min: 1, max: 60 } as const;

export type TriggerParams = { days?: number };

function validateTriggerParams(trigger: Trigger, input: unknown): { ok: true; params: TriggerParams } | { ok: false; issues: RuleIssue[] } {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [{ path: "triggerParams", message: "Invalid trigger settings." }] };
  const keys = Object.keys(raw as object);
  const range = trigger === "INVOICE_OVERDUE" ? OVERDUE_DAYS_RANGE : trigger === "BILL_DUE_SOON" ? DUE_SOON_DAYS_RANGE : null;
  if (!range) {
    if (keys.length > 0) return { ok: false, issues: [{ path: "triggerParams", message: "This trigger takes no settings." }] };
    return { ok: true, params: {} };
  }
  if (keys.some((k) => k !== "days")) return { ok: false, issues: [{ path: "triggerParams", message: "Only the number of days can be set." }] };
  const days = (raw as { days?: unknown }).days;
  const asNumber = typeof days === "number" ? days : typeof days === "string" && /^\d{1,4}$/.test(days) ? Number(days) : NaN;
  if (!Number.isInteger(asNumber) || asNumber < range.min || asNumber > range.max) {
    return { ok: false, issues: [{ path: "triggerParams.days", message: `Enter a number of days from ${range.min} to ${range.max}.` }] };
  }
  return { ok: true, params: { days: asNumber } };
}

// ---- The rule ---------------------------------------------------------------------------------------------------------

export const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 300;

export interface RuleSpec {
  name: string;
  description: string | null;
  trigger: Trigger;
  triggerParams: TriggerParams;
  conditions: Condition[];
  action: RuleAction;
}

/**
 * Validates a whole rule from untrusted input (a form, a stored row). Returns the NORMALISED spec or every issue found.
 * Unknown triggers, fields, operators and actions are all refused; injection-looking text in a name, a message or a
 * condition value is simply inert data (it is length-limited, control characters are refused, and it is only ever
 * rendered as text).
 */
export function validateRuleSpec(input: unknown): { ok: true; spec: RuleSpec } | { ok: false; issues: RuleIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: [{ path: "", message: "A rule must be an object." }] };
  const raw = input as Record<string, unknown>;
  const issues: RuleIssue[] = [];
  const allowedKeys = new Set(["name", "description", "trigger", "triggerParams", "conditions", "action"]);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) issues.push({ path: key, message: `Unknown setting "${key}".` });

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_CHARS) issues.push({ path: "name", message: `Give the rule a name of 1 to ${MAX_NAME_CHARS} characters.` });
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f]/.test(name)) issues.push({ path: "name", message: "The name must not contain control characters." });

  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null && raw.description !== "") {
    // eslint-disable-next-line no-control-regex
    if (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.description)) {
      issues.push({ path: "description", message: `The description must be plain text of at most ${MAX_DESCRIPTION_CHARS} characters.` });
    } else description = raw.description.trim() || null;
  }

  const trigger = typeof raw.trigger === "string" && (TRIGGERS as readonly string[]).includes(raw.trigger) ? (raw.trigger as Trigger) : null;
  if (!trigger) {
    issues.push({ path: "trigger", message: "Choose one of the available triggers." });
    return { ok: false, issues };
  }

  const params = validateTriggerParams(trigger, raw.triggerParams);
  if (!params.ok) issues.push(...params.issues);

  const conditions: Condition[] = [];
  const rawConditions = raw.conditions === undefined ? [] : raw.conditions;
  if (!Array.isArray(rawConditions)) issues.push({ path: "conditions", message: "Conditions must be a list." });
  else if (rawConditions.length > MAX_CONDITIONS) issues.push({ path: "conditions", message: `At most ${MAX_CONDITIONS} conditions.` });
  else {
    rawConditions.forEach((c, index) => {
      const checked = validateCondition(trigger, c);
      if (checked.ok) conditions.push(checked.condition);
      else issues.push(...checked.issues.map((i) => ({ path: `conditions.${index}.${i.path}`, message: i.message })));
    });
  }

  const action = actionSchema.safeParse(raw.action);
  if (!action.success) {
    issues.push(...action.error.issues.map((i) => ({ path: `action.${i.path.join(".")}`, message: i.message })));
  } else if (!ACTION_TRIGGERS[action.data.type].includes(trigger)) {
    issues.push({ path: "action", message: `"${ACTION_INFO[action.data.type].label}" cannot be used with this trigger.` });
  }

  if (issues.length > 0 || !params.ok || !action.success) return { ok: false, issues };
  return { ok: true, spec: { name, description, trigger, triggerParams: params.params, conditions, action: action.data } };
}

// ---- Deterministic arithmetic and keys --------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Start of the UTC calendar day containing `date`. Due dates are calendar dates stored at UTC midnight. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Whole calendar days a document is past its due date as of `now` (0 on the due date itself, negative before it). */
export function daysOverdue(dueDate: Date, now: Date): number {
  return Math.floor((startOfUtcDay(now).getTime() - startOfUtcDay(dueDate).getTime()) / DAY_MS);
}

/** Whole calendar days until a due date as of `now` (0 on the due date, negative once overdue). */
export function daysUntilDue(dueDate: Date, now: Date): number {
  return 0 - daysOverdue(dueDate, now);
}

export const eventJobKey = (eventId: string) => `event:${eventId}`;
export const overdueJobKey = (invoiceId: string, days: number) => `invoice:${invoiceId}:overdue:${days}`;
export const dueSoonJobKey = (billId: string, days: number) => `bill:${billId}:due_soon:${days}`;
export const reorderJobKey = (productId: string) => `reorder:${productId}`;

// ---- Limits and constants ---------------------------------------------------------------------------------------------

export const MAX_RULES_PER_ORG = 50;
/** Per rule, per evaluation pass. */
export const MAX_RULE_RUNS_PER_PASS = 10;
/** Across all rules of an organization, per evaluation pass. */
export const MAX_ORG_RUNS_PER_PASS = 30;
/** Per rule, per rolling 24 hours. */
export const MAX_RULE_RUNS_PER_DAY = 100;
/** Across all rules of an organization, per rolling 24 hours. */
export const MAX_ORG_RUNS_PER_DAY = 300;
/** Outbox events examined per pass. */
export const EVENT_BATCH = 50;
/** Rows examined per scan rule per pass. */
export const SCAN_BATCH = 25;
/** An event older than this is marked processed without firing (a rule never reacts to long-stale news). */
export const MAX_EVENT_AGE_MS = 72 * 3_600_000;
/** Consecutive failed runs after which a rule is switched off automatically. */
export const AUTO_DISABLE_AFTER_FAILURES = 5;
/** A channel send is attempted at most this many times in total. */
export const MAX_SEND_ATTEMPTS = 3;
/**
 * A rule only reacts to events that occurred at or after the moment it was last created, edited or enabled. Both that moment
 * and an event's `occurred_at` are stamped by the APPLICATION clock (never the database default), so they are comparable
 * without a skew allowance.
 */
export const RULE_EVENT_SKEW_MS = 0;
export const JOB_LEASE_MS = 5 * 60_000;
/** Jobs and runs older than this are removed by the retention purge. */
export const AUTOMATION_RETENTION_DAYS = 90;

/** Delay before retry attempt number `attempt` (1-based count of attempts already made). */
export function retryDelayMs(attemptsMade: number): number {
  return attemptsMade <= 1 ? 60_000 : 300_000;
}
