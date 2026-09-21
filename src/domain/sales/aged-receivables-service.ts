import { and, eq, ne } from "drizzle-orm";
import { contacts, invoices } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
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
};
