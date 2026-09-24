import { and, eq, ne } from "drizzle-orm";
import { contacts, invoices, paymentAllocations, payments } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { calculateCollectionPriorityScore } from "./collection-priority";
import { loadAllocatedTotal } from "./invoice-service";

export const AGING_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "days90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgedInvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: Date;
  total: string;
  outstanding: string;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface AgedCustomerRow {
  customerContactId: string;
  customerName: string;
  invoices: AgedInvoiceRow[];
  totals: Record<AgingBucket, string>;
  totalOutstanding: string;
}

function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "days1to30";
  if (daysPastDue <= 60) return "days31to60";
  if (daysPastDue <= 90) return "days61to90";
  return "days90plus";
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

export interface PrioritizedInvoiceRow extends AgedInvoiceRow {
  customerContactId: string;
  customerName: string;
  /**
   * This customer's historical average days late across their own
   * already-PAID invoices (settlement date − due date; negative means they
   * typically pay early). `null` when they have no settled invoice yet —
   * see `src/domain/sales/collection-priority.ts`.
   */
  customerAvgDaysLate: number | null;
  /** 0–100, higher = chase sooner. See `calculateCollectionPriorityScore`. */
  priorityScore: number;
}

/**
 * This customer's average days late across their own settled (PAID)
 * invoices: for each, the latest allocation's `paymentDate` stands in for
 * "the day it was settled" (the ledger has no separate "paid in full at"
 * timestamp — see docs/accounting-engine.md), compared against `dueDate`.
 * Returns `null` for a customer with no PAID invoice yet, so the caller can
 * treat "no history" as neutral rather than as "always on time".
 */
async function customerAverageDaysLate(
  tx: TenantDb,
  organizationId: string,
  customerContactId: string,
): Promise<number | null> {
  const paidInvoices = await tx
    .select({ id: invoices.id, dueDate: invoices.dueDate })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.customerContactId, customerContactId),
        eq(invoices.status, "PAID"),
      ),
    );

  if (paidInvoices.length === 0) return null;

  const daysLateByInvoice: number[] = [];
  for (const invoice of paidInvoices) {
    const rows = await tx
      .select({ paymentDate: payments.paymentDate })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.invoiceId, invoice.id)));
    if (rows.length === 0) continue;

    const settleDate = rows.reduce(
      (latest, r) => (new Date(r.paymentDate).getTime() > latest.getTime() ? new Date(r.paymentDate) : latest),
      new Date(0),
    );
    daysLateByInvoice.push(daysBetween(settleDate, new Date(invoice.dueDate)));
  }

  if (daysLateByInvoice.length === 0) return null;
  const sum = daysLateByInvoice.reduce((a, b) => a + b, 0);
  return Math.round((sum / daysLateByInvoice.length) * 100) / 100;
}

/**
 * Master spec §32: Aged Receivables, current/1-30/31-60/61-90/90+ buckets
 * per customer, drilling down to invoices. Every unpaid, posted invoice is
 * bucketed by days past its due date as of `asOfDate` — computed fresh from
 * `payment_allocations` (via `loadAllocatedTotal`), never a cached balance
 * that could drift from the ledger.
 */
export const AgedReceivablesService = {
  async get(actor: Actor, asOfDate: Date = new Date()): Promise<AgedCustomerRow[]> {
    assertPermission(actor, "customer_invoice:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ invoice: invoices, customer: contacts })
        .from(invoices)
        .innerJoin(contacts, eq(contacts.id, invoices.customerContactId))
        .where(
          and(
            eq(invoices.organizationId, actor.organizationId),
            ne(invoices.status, "DRAFT"),
            ne(invoices.status, "VOID"),
            ne(invoices.status, "PAID"),
          ),
        );

      const byCustomer = new Map<string, AgedCustomerRow>();

      for (const row of rows) {
        const allocated = await loadAllocatedTotal(tx, actor.organizationId, row.invoice.id);
        const outstanding = Money.of(row.invoice.total, row.invoice.currency).subtract(
          Money.of(allocated, row.invoice.currency),
        );
        if (!outstanding.isPositive()) continue;

        const daysPastDue = daysBetween(asOfDate, new Date(row.invoice.dueDate));
        const bucket = bucketFor(daysPastDue);

        let customerRow = byCustomer.get(row.customer.id);
        if (!customerRow) {
          customerRow = {
            customerContactId: row.customer.id,
            customerName: row.customer.displayName,
            invoices: [],
            totals: {
              current: "0.0000",
              days1to30: "0.0000",
              days31to60: "0.0000",
              days61to90: "0.0000",
              days90plus: "0.0000",
            },
            totalOutstanding: "0.0000",
          };
          byCustomer.set(row.customer.id, customerRow);
        }

        customerRow.invoices.push({
          invoiceId: row.invoice.id,
          invoiceNumber: row.invoice.invoiceNumber,
          dueDate: new Date(row.invoice.dueDate),
          total: row.invoice.total,
          outstanding: outstanding.toString(),
          daysPastDue,
          bucket,
        });

        customerRow.totals[bucket] = Money.of(customerRow.totals[bucket], row.invoice.currency)
          .add(outstanding)
          .toString();
        customerRow.totalOutstanding = Money.of(customerRow.totalOutstanding, row.invoice.currency)
          .add(outstanding)
          .toString();
      }

      return [...byCustomer.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
    });
  },

  /**
   * The same overdue-invoice data as `get`, flattened to one row per
   * invoice and augmented with a Collection Priority Score — "who to chase
   * first" — sorted highest-priority first. Extends the existing Aged
   * Receivables data rather than duplicating the aging computation.
   */
  async getWithPriority(actor: Actor, asOfDate: Date = new Date()): Promise<PrioritizedInvoiceRow[]> {
    assertPermission(actor, "customer_invoice:read");
    const customerRows = await AgedReceivablesService.get(actor, asOfDate);

    return withTenant(actor.organizationId, async (tx) => {
      const avgDaysLateByCustomer = new Map<string, number | null>();
      for (const customer of customerRows) {
        avgDaysLateByCustomer.set(
          customer.customerContactId,
          await customerAverageDaysLate(tx, actor.organizationId, customer.customerContactId),
        );
      }

      const rows: PrioritizedInvoiceRow[] = customerRows.flatMap((customer) =>
        customer.invoices.map((invoice) => {
          const customerAvgDaysLate = avgDaysLateByCustomer.get(customer.customerContactId) ?? null;
          return {
            ...invoice,
            customerContactId: customer.customerContactId,
            customerName: customer.customerName,
            customerAvgDaysLate,
            priorityScore: calculateCollectionPriorityScore({
              outstandingAmount: invoice.outstanding,
              daysPastDue: invoice.daysPastDue,
              customerAvgDaysLate,
            }),
          };
        }),
      );

      return rows.sort((a, b) => b.priorityScore - a.priorityScore);
    });
  },
};
