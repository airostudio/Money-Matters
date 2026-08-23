import { sql, eq } from "drizzle-orm";
import { journalEntries } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Sequential per-organization entry numbers, e.g. "JE-000123". Phase 1
 * derives the next number from a row count inside the same transaction as
 * the insert; the (organizationId, entryNumber) unique index is the backstop
 * against a concurrent-post race producing a duplicate — a collision aborts
 * the transaction rather than silently reusing a number. A dedicated
 * per-organization counter/sequence would remove even that narrow race
 * window; revisit if concurrent posting volume in Phase 2+ makes retries
 * from unique-constraint failures a real cost.
 */
export async function nextEntryNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `JE-${String(count + 1).padStart(6, "0")}`;
}
