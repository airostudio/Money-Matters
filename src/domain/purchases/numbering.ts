import { sql, eq } from "drizzle-orm";
import { bills } from "@/db/schema";
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
