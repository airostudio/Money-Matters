/**
 * The webhook event catalogue and envelope (master spec s.55 / s.65). CLOSED: a subscription lists concrete types from
 * this list; there is no wildcard in v1. Every payload is the public API's DTO for the aggregate (src/domain/api/dto.ts),
 * so a webhook can never disclose more than the API would.
 *
 * Deliberately NOT here: `payroll.completed` (payroll is outside the public API surface) and `bank.transaction.created`
 * (bank transactions have no API DTO) - they wait until their data can be exposed under the same permission rules.
 */
export const EVENT_TYPES = [
  "customer.created",
  "supplier.created",
  "invoice.created",
  "invoice.sent",
  "invoice.paid",
  "payment.received",
  "bill.created",
  "bill.approved",
  // Phase 10 Slice 3: emitted by the Automation Centre's EMIT_WEBHOOK_EVENT action (origin = automation). Never an automation trigger.
  "automation.triggered",
] as const;

export type WebhookEventType = (typeof EVENT_TYPES)[number];

/** The synthetic event posted by "Send test event". Never subscribable, never emitted by business code. */
export const PING_EVENT_TYPE = "ping";

export const EVENT_INFO: Record<WebhookEventType, { label: string; description: string; aggregate: string }> = {
  "customer.created": { label: "Customer created", description: "A customer (or a contact that is both customer and supplier) was added.", aggregate: "Contact" },
  "supplier.created": { label: "Supplier created", description: "A supplier (or a contact that is both customer and supplier) was added.", aggregate: "Contact" },
  "invoice.created": { label: "Invoice created", description: "A draft invoice was created.", aggregate: "Invoice" },
  "invoice.sent": { label: "Invoice sent", description: "An approved invoice was marked as sent.", aggregate: "Invoice" },
  "invoice.paid": { label: "Invoice paid", description: "Payments now cover the invoice in full.", aggregate: "Invoice" },
  "payment.received": { label: "Payment received", description: "A customer payment was recorded and allocated.", aggregate: "Payment" },
  "bill.created": { label: "Bill created", description: "A draft bill was created.", aggregate: "Bill" },
  "bill.approved": { label: "Bill approved", description: "A bill was approved and posted.", aggregate: "Bill" },
  "automation.triggered": { label: "Automation triggered", description: "An automation rule you configured fired and chose to emit this event.", aggregate: "AutomationRule" },
};

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export const WEBHOOK_API_VERSION = "v1";

/**
 * Upper bound on the serialised envelope. An invoice with a very large number of lines could exceed it; rather than fail
 * the business transaction (never acceptable) the lines are dropped from the snapshot and `data.truncated` is set, so the
 * consumer fetches the full object from the API by id.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;

export interface EventEnvelope {
  id: string;
  type: string;
  api_version: typeof WEBHOOK_API_VERSION;
  created_at: string;
  data: { object: Record<string, unknown>; truncated?: true };
}

export function buildEnvelope(params: { id: string; type: string; occurredAt: Date; object: Record<string, unknown> }): EventEnvelope {
  const base: EventEnvelope = {
    id: params.id,
    type: params.type,
    api_version: WEBHOOK_API_VERSION,
    created_at: params.occurredAt.toISOString(),
    data: { object: params.object },
  };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") <= MAX_EVENT_PAYLOAD_BYTES) return base;

  // Over the cap: drop the bulky collections (lines / allocations), keep the scalar summary, and say so.
  const { lines: _lines, allocations: _allocations, ...summary } = params.object as Record<string, unknown>;
  void _lines;
  void _allocations;
  const trimmed: EventEnvelope = { ...base, data: { object: summary, truncated: true } };
  if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") <= MAX_EVENT_PAYLOAD_BYTES) return trimmed;
  // A scalar summary that is still too large cannot happen with the API's DTOs, but never store an unbounded row.
  return { ...base, data: { object: { id: String(params.object.id ?? "") }, truncated: true } };
}
