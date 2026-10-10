import { sql, eq } from "drizzle-orm";
import { expenseClaims } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Sequential per-organization expense claim numbers, e.g. "EXP-000123" —
 * same approach and same caveat as `src/domain/purchases/numbering.ts`:
 * derived from a row count inside the same transaction as the insert, with
 * the (organizationId, claimNumber) unique index as the backstop against a
 * concurrent-create race.
 */
export async function nextExpenseClaimNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(expenseClaims)
    .where(eq(expenseClaims.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `EXP-${String(count + 1).padStart(6, "0")}`;
}
