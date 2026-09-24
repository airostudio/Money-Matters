import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import type { AccountType } from "@/domain/accounts/account-service";

export interface AccountActivitySum {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subType: string | null;
  isSystemAccount: boolean;
  /** Base-currency decimal string. */
  totalDebit: string;
  /** Base-currency decimal string. */
  totalCredit: string;
}

export interface AccountActivityRange {
  /** Inclusive lower bound on `postingDate`. Omit for "since account inception". */
  from?: Date;
  /** Inclusive upper bound on `postingDate`. */
  to: Date;
}

/**
 * Every account in the organization with its posted (non-DRAFT) activity
 * summed in the base currency over `range` — the single shared query behind
 * the Trial Balance (`LedgerService.getTrialBalance`, `range = { to: asOf }`)
 * and every Phase 5 financial statement (P&L needs a bounded period, Balance
 * Sheet needs `{ to: asOf }`, Cash Flow needs both a period slice and two
 * as-of-date snapshots to diff). Keeping one query here means a future
 * dimension filter (master spec §4) is one extra `and(...)` clause, not a
 * rewrite scattered across four call sites.
 *
 * Every account in the org is returned, even with zero activity in range —
 * callers that only want non-zero rows filter afterwards (see
 * `docs/accounting-engine.md`'s note on why trial balance keeps zero rows
 * out of its own display but this shared helper doesn't decide that).
 */
export async function sumPostedActivityByAccount(
  tx: TenantDb,
  organizationId: string,
  range: AccountActivityRange,
): Promise<AccountActivitySum[]> {
  const dateConditions = [lte(journalEntries.postingDate, range.to)];
  if (range.from) dateConditions.push(gte(journalEntries.postingDate, range.from));

  const postedLines = tx
    .select({
      accountId: journalLines.accountId,
      baseDebit: journalLines.baseDebit,
      baseCredit: journalLines.baseCredit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.organizationId, organizationId),
        // A REVERSED entry is still permanent ledger history — see
        // LedgerService.getTrialBalance's identical comment. DRAFT is the
        // only status with no ledger effect.
        ne(journalEntries.status, "DRAFT"),
        ...dateConditions,
      ),
    )
    .as("posted_lines");

  return tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subType: accounts.subType,
      isSystemAccount: accounts.isSystemAccount,
      totalDebit: sql<string>`coalesce(sum(${postedLines.baseDebit}), 0)`,
      totalCredit: sql<string>`coalesce(sum(${postedLines.baseCredit}), 0)`,
    })
    .from(accounts)
    .leftJoin(postedLines, eq(postedLines.accountId, accounts.id))
    .where(eq(accounts.organizationId, organizationId))
    .groupBy(accounts.id, accounts.code, accounts.name, accounts.type, accounts.subType, accounts.isSystemAccount)
    .orderBy(accounts.code);
}
