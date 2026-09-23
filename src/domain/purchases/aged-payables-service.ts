import { and, eq, ne } from "drizzle-orm";
import { contacts, bills } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { loadAllocatedTotal } from "./bill-service";

export const AGING_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "days90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgedBillRow {
  billId: string;
  billNumber: string;
  dueDate: Date;
  total: string;
  outstanding: string;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface AgedSupplierRow {
  supplierContactId: string;
  supplierName: string;
  bills: AgedBillRow[];
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
 * Master spec §32/§16: Aged Payables, current/1-30/31-60/61-90/90+ buckets
 * per supplier, drilling down to bills — the mirror of
 * `src/domain/sales/aged-receivables-service.ts`. Every unpaid, posted bill
 * is bucketed by days past its due date as of `asOfDate` — computed fresh
 * from `supplier_payment_allocations` (via `loadAllocatedTotal`), never a
 * cached balance that could drift from the ledger.
 */
export const AgedPayablesService = {
  async get(actor: Actor, asOfDate: Date = new Date()): Promise<AgedSupplierRow[]> {
    assertPermission(actor, "supplier_bill:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ bill: bills, supplier: contacts })
        .from(bills)
        .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
        .where(
          and(
            eq(bills.organizationId, actor.organizationId),
            ne(bills.status, "DRAFT"),
            ne(bills.status, "VOID"),
            ne(bills.status, "PAID"),
          ),
        );

      const bySupplier = new Map<string, AgedSupplierRow>();

      for (const row of rows) {
        const allocated = await loadAllocatedTotal(tx, actor.organizationId, row.bill.id);
        const outstanding = Money.of(row.bill.total, row.bill.currency).subtract(
          Money.of(allocated, row.bill.currency),
        );
        if (!outstanding.isPositive()) continue;

        const daysPastDue = daysBetween(asOfDate, new Date(row.bill.dueDate));
        const bucket = bucketFor(daysPastDue);

        let supplierRow = bySupplier.get(row.supplier.id);
        if (!supplierRow) {
          supplierRow = {
            supplierContactId: row.supplier.id,
            supplierName: row.supplier.displayName,
            bills: [],
            totals: {
              current: "0.0000",
              days1to30: "0.0000",
              days31to60: "0.0000",
              days61to90: "0.0000",
              days90plus: "0.0000",
            },
            totalOutstanding: "0.0000",
          };
          bySupplier.set(row.supplier.id, supplierRow);
        }

        supplierRow.bills.push({
          billId: row.bill.id,
          billNumber: row.bill.billNumber,
          dueDate: new Date(row.bill.dueDate),
          total: row.bill.total,
          outstanding: outstanding.toString(),
          daysPastDue,
          bucket,
        });

        supplierRow.totals[bucket] = Money.of(supplierRow.totals[bucket], row.bill.currency)
          .add(outstanding)
          .toString();
        supplierRow.totalOutstanding = Money.of(supplierRow.totalOutstanding, row.bill.currency)
          .add(outstanding)
          .toString();
      }

      return [...bySupplier.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
    });
  },
};
