import type { JobContext } from "./context";
import type { Trigger } from "./vocabulary";

/**
 * Message text for notifications and channel messages, built from FIXED templates and the job's public data. There is no
 * template language and no substitution of user-supplied placeholders: the only person-written text is the rule name and
 * the optional short `message`, which are inserted as inert text (escaped again by whatever renders them).
 *
 * Default content is MINIMAL: what happened and a link. An amount line is produced separately and shown only when the
 * destination opted in (`includeAmounts`).
 */
export interface Described {
  title: string;
  body: string;
  /** In-app path (`/<orgSlug>/...`). */
  path: string;
  /** e.g. "Total 120.00 AUD", or null when the subject has no amount. */
  amountLine: string | null;
}

const who = (name: string | null) => (name ? ` for ${name}` : "");
const from = (name: string | null) => (name ? ` from ${name}` : "");

function pathFor(slug: string, c: JobContext): string {
  switch (c.objectType) {
    case "Invoice":
      return `/${slug}/sales/invoices/${c.objectId}`;
    case "Bill":
      return `/${slug}/purchases/bills/${c.objectId}`;
    case "Payment":
      return `/${slug}/sales/invoices`;
    case "Product":
      return `/${slug}/inventory/${c.objectId}`;
    case "Contact":
      return c.trigger === "supplier.created" ? `/${slug}/purchases/suppliers/${c.objectId}` : `/${slug}/sales/customers/${c.objectId}`;
  }
}

function sentence(trigger: Trigger, c: JobContext): string {
  const num = c.number ? ` ${c.number}` : "";
  switch (trigger) {
    case "customer.created":
      return c.name ? `Customer ${c.name} was added.` : "A customer was added.";
    case "supplier.created":
      return c.name ? `Supplier ${c.name} was added.` : "A supplier was added.";
    case "invoice.created":
      return `Invoice${num}${who(c.name)} was created.`;
    case "invoice.sent":
      return `Invoice${num}${who(c.name)} was sent.`;
    case "invoice.paid":
      return `Invoice${num}${who(c.name)} was paid in full.`;
    case "payment.received":
      return `A payment${c.name ? ` from ${c.name}` : ""} was received.`;
    case "bill.created":
      return `Bill${num}${from(c.name)} was created.`;
    case "bill.approved":
      return `Bill${num}${from(c.name)} was approved.`;
    case "INVOICE_OVERDUE": {
      const days = Number(c.facts.days_overdue ?? 0);
      return `Invoice${num}${who(c.name)} is ${days} day${days === 1 ? "" : "s"} overdue.`;
    }
    case "BILL_DUE_SOON": {
      const days = Number(c.facts.days_until_due ?? 0);
      return days <= 0 ? `Bill${num}${from(c.name)} is due today.` : `Bill${num}${from(c.name)} is due in ${days} day${days === 1 ? "" : "s"}.`;
    }
    case "INVENTORY_BELOW_REORDER":
      return `${c.name ?? "A product"}${c.number ? ` (${c.number})` : ""} is at or below its reorder point.`;
  }
}

function amountLineFor(c: JobContext): string | null {
  const cur = c.currency ? ` ${c.currency}` : "";
  if (c.trigger === "INVENTORY_BELOW_REORDER") {
    const qty = c.facts.quantity_on_hand;
    const point = c.facts.reorder_point;
    return qty !== null && qty !== undefined && point !== null && point !== undefined ? `On hand ${qty}, reorder point ${point}` : null;
  }
  if (c.amountDue && c.total && (c.trigger === "INVOICE_OVERDUE" || c.trigger === "BILL_DUE_SOON")) return `Amount due ${c.amountDue}${cur}`;
  if (c.total) return `Total ${c.total}${cur}`;
  if (c.amount) return `Amount ${c.amount}${cur}`;
  return null;
}

export function describeSubject(context: JobContext, orgSlug: string, ruleName: string, customMessage?: string | null): Described {
  const lead = customMessage?.trim() ? `${customMessage.trim()} ` : "";
  return {
    title: ruleName,
    body: `${lead}${sentence(context.trigger, context)}`.trim(),
    path: pathFor(orgSlug, context),
    amountLine: amountLineFor(context),
  };
}

/** The application's public origin, for links inside channel messages. Null when it is not configured (the message then simply carries no link). */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}
