/**
 * The invoices list's "Unpaid" and "Overdue" views (the palette's "Find unpaid invoices" command links to
 * `/sales/invoices?filter=unpaid`). Pure so the rule is testable without a database: it reads the same fields the
 * list already shows (status, due date, total, amount paid) and changes nothing.
 *
 * Unpaid = posted to the ledger and not yet fully paid: APPROVED, SENT, VIEWED or PART_PAID with money still owing.
 * A DRAFT is not yet owed, a VOID is cancelled, a PAID one is settled. Overdue = unpaid and past its due date.
 */
export const INVOICE_FILTERS = ["unpaid", "overdue"] as const;
export type InvoiceListFilter = (typeof INVOICE_FILTERS)[number];

const UNPAID_STATUSES = new Set(["APPROVED", "SENT", "VIEWED", "PART_PAID"]);

export function parseInvoiceFilter(value: string | undefined | null): InvoiceListFilter | undefined {
  return (INVOICE_FILTERS as readonly string[]).includes(value ?? "") ? (value as InvoiceListFilter) : undefined;
}

export interface FilterableInvoice {
  status: string;
  dueDate: Date | string;
}

export function matchesInvoiceFilter(filter: InvoiceListFilter, invoice: FilterableInvoice, now: Date): boolean {
  if (!UNPAID_STATUSES.has(invoice.status)) return false;
  if (filter === "unpaid") return true;
  return new Date(invoice.dueDate).getTime() < now.getTime();
}
