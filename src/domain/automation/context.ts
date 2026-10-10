import { TRIGGER_INFO, type Facts, type Trigger } from "./vocabulary";

/**
 * The "subject" of a job: what happened, in public-API-visible terms only. It is stored on the job row (`automation_jobs.
 * context`) so a retry or a later notification does not need to re-read anything, and it NEVER holds more than the public
 * API (or the webhook event) already exposes: ids, document numbers, counterparty display names, currency and amounts as
 * decimal STRINGS, due dates. Money is never a float anywhere in here.
 */
export type SubjectType = "Invoice" | "Bill" | "Payment" | "Contact" | "Product";

export interface JobContext {
  v: 1;
  trigger: Trigger;
  source: "event" | "scan";
  eventId: string | null;
  objectType: SubjectType;
  objectId: string;
  /** Invoice / bill number, or a product SKU. */
  number: string | null;
  /** Counterparty or contact display name, or a product name. */
  name: string | null;
  currency: string | null;
  total: string | null;
  amountDue: string | null;
  amount: string | null;
  dueDate: string | null;
  facts: Facts;
  /** The public-API DTO of the object, when the trigger has one and it is small. Used only by EMIT_WEBHOOK_EVENT. */
  dto: Record<string, unknown> | null;
}

export const MAX_DTO_BYTES = 16 * 1024;

function dig(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asDecimal = (value: unknown): string | null => (typeof value === "string" && /^-?\d{1,15}(\.\d{1,4})?$/.test(value) ? value : null);

/** Builds the job context from an outbox event's payload (the envelope the webhook slice stored). Total and defensive: bad data gives nulls, never an exception. */
export function contextFromEvent(trigger: Trigger, eventId: string, payload: unknown): JobContext {
  const object = dig(payload, "data", "object");
  const info = TRIGGER_INFO[trigger];
  const base = {
    v: 1 as const,
    trigger,
    source: "event" as const,
    eventId,
    objectType: info.object as SubjectType,
    objectId: asString(dig(object, "id")) ?? "",
    number: null as string | null,
    name: null as string | null,
    currency: null as string | null,
    total: null as string | null,
    amountDue: null as string | null,
    amount: null as string | null,
    dueDate: null as string | null,
    facts: {} as Facts,
  };
  let dto: Record<string, unknown> | null = null;
  if (typeof object === "object" && object !== null && !Array.isArray(object)) {
    try {
      dto = Buffer.byteLength(JSON.stringify(object), "utf8") <= MAX_DTO_BYTES ? (object as Record<string, unknown>) : null;
    } catch {
      dto = null;
    }
  }
  switch (trigger) {
    case "invoice.created":
    case "invoice.sent":
    case "invoice.paid":
    case "bill.created":
    case "bill.approved": {
      const party = info.object === "Invoice" ? "customer" : "supplier";
      const idField = info.object === "Invoice" ? "customer_id" : "supplier_id";
      const currency = asString(dig(object, "currency"));
      const total = asDecimal(dig(object, "total", "amount"));
      const amountDue = asDecimal(dig(object, "amount_due", "amount"));
      return {
        ...base,
        number: asString(dig(object, "number")),
        name: asString(dig(object, party, "display_name")),
        currency,
        total,
        amountDue,
        dueDate: asString(dig(object, "due_date")),
        facts: { total, amount_due: amountDue, [idField]: asString(dig(object, party, "id")), currency },
        dto,
      };
    }
    case "payment.received": {
      const currency = asString(dig(object, "amount", "currency"));
      const amount = asDecimal(dig(object, "amount", "amount"));
      return {
        ...base,
        name: asString(dig(object, "customer", "display_name")),
        currency,
        amount,
        facts: { amount, customer_id: asString(dig(object, "customer", "id")), method: asString(dig(object, "method")), currency },
        dto,
      };
    }
    case "customer.created":
    case "supplier.created": {
      const currency = asString(dig(object, "currency"));
      return { ...base, name: asString(dig(object, "display_name")), currency, facts: { kind: asString(dig(object, "kind")), currency }, dto };
    }
    default:
      return { ...base, dto };
  }
}

/** A fact an event-driven rule can read must be listed for its trigger: used to drop anything else defensively. */
export function parseJobContext(value: unknown): JobContext | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Partial<JobContext>;
  if (c.v !== 1 || typeof c.objectId !== "string" || typeof c.objectType !== "string" || typeof c.trigger !== "string") return null;
  return c as JobContext;
}
