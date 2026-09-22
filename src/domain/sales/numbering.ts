import { sql, eq } from "drizzle-orm";
import { invoices } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Sequential per-organization invoice numbers, e.g. "INV-000123" — same
 * approach and same caveat as `src/domain/ledger/numbering.ts`: derived from
 * a row count inside the same transaction as the insert, with the
 * (organizationId, invoiceNumber) unique index as the backstop against a
 * concurrent-create race.
 */
export async function nextInvoiceNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `INV-${String(count + 1).padStart(6, "0")}`;
}
