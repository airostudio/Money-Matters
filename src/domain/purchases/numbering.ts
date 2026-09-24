import { sql, eq } from "drizzle-orm";
import { bills, paymentRuns, purchaseOrders, supplierCreditNotes } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Sequential per-organization bill numbers, e.g. "BILL-000123" — same
 * approach and same caveat as `src/domain/sales/numbering.ts`: derived from
 * a row count inside the same transaction as the insert, with the
 * (organizationId, billNumber) unique index as the backstop against a
 * concurrent-create race.
 */
export async function nextBillNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(bills)
    .where(eq(bills.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `BILL-${String(count + 1).padStart(6, "0")}`;
}

/** Sequential per-organization purchase order numbers, e.g. "PO-000123" — same approach and caveat as `nextBillNumber`. */
export async function nextPurchaseOrderNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `PO-${String(count + 1).padStart(6, "0")}`;
}

/** Sequential per-organization supplier credit note numbers, e.g. "SCN-000123". */
export async function nextSupplierCreditNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(supplierCreditNotes)
    .where(eq(supplierCreditNotes.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `SCN-${String(count + 1).padStart(6, "0")}`;
}

/** Sequential per-organization payment run numbers, e.g. "RUN-000123". */
export async function nextPaymentRunNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentRuns)
    .where(eq(paymentRuns.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `RUN-${String(count + 1).padStart(6, "0")}`;
}
