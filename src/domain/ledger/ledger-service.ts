import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { accounts, contacts, journalEntries, journalLines, organizations, taxCodes } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Loads lines for a set of entries via an explicit join, NOT Drizzle's
 * relational query API (`db.query.*` with nested `with:`). On Postgres,
 * that API fetches nested relations through a server-side JSON aggregate,
 * and Postgres's numeric-to-json cast becomes a JSON *number* literal —
 * which `JSON.parse` on the JS side then turns into a native float,
 * silently reintroducing the exact precision loss
 * docs/accounting-engine.md §4 forbids (verified empirically: a
 * numeric(19,4) value of 123.4567890123 round-trips through the nested
 * query as the float 123.4568). A plain join keeps every amount as the
 * driver's untouched decimal-string text.
 */
async function loadLinesForEntries(tx: TenantDb, organizationId: string, entryIds: string[]) {
  if (entryIds.length === 0) return new Map<string, LineWithRelations[]>();

  const rows = await tx
    .select({ line: journalLines, account: accounts, contact: contacts, taxCode: taxCodes })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(contacts, eq(contacts.id, journalLines.contactId))
    .leftJoin(taxCodes, eq(taxCodes.id, journalLines.taxCodeId))
    .where(
      and(eq(journalLines.organizationId, organizationId), inArray(journalLines.journalEntryId, entryIds)),
    )
    .orderBy(asc(journalLines.lineNumber));

  const byEntry = new Map<string, LineWithRelations[]>();
  for (const row of rows) {
    const list = byEntry.get(row.line.journalEntryId) ?? [];
    list.push({ ...row.line, account: row.account, contact: row.contact, taxCode: row.taxCode });
    byEntry.set(row.line.journalEntryId, list);
  }
  return byEntry;
}

type JournalLineRow = typeof journalLines.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type ContactRow = typeof contacts.$inferSelect;
type TaxCodeRow = typeof taxCodes.$inferSelect;
export interface LineWithRelations extends JournalLineRow {
  account: AccountRow;
  contact: ContactRow | null;
  taxCode: TaxCodeRow | null;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Normal-balance-signed total in the org's base currency: positive means "in the account's normal direction". */
  balance: string;
  totalDebit: string;
  totalCredit: string;
}

export function normalBalanceSide(type: AccountType): "DEBIT" | "CREDIT" {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

export const LedgerService = {
  /**
   * Every account in the organization with its posted, as-of-date activity
   * summed in the base currency — the foundation for the Trial Balance
   * report and for account balance displays throughout the UI.
   */
  async getTrialBalance(actor: Actor, asOfDate: Date = new Date()): Promise<TrialBalanceRow[]> {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [org] = await tx
        .select({ baseCurrency: organizations.baseCurrency })
        .from(organizations)
        .where(eq(organizations.id, actor.organizationId));
      const baseCurrency = org?.baseCurrency ?? "AUD";

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
            eq(journalEntries.organizationId, actor.organizationId),
            // A REVERSED entry is still permanent ledger history — its
            // lines stay in every balance calculation. Only its NEW
            // reversal entry's opposite postings cancel the effect out.
            // DRAFT is the only status with no ledger effect. See
            // docs/accounting-engine.md §1.
            ne(journalEntries.status, "DRAFT"),
            lte(journalEntries.postingDate, asOfDate),
          ),
        )
        .as("posted_lines");

      const aggregated = await tx
        .select({
          accountId: accounts.id,
          code: accounts.code,
          name: accounts.name,
          type: accounts.type,
          totalDebit: sql<string>`coalesce(sum(${postedLines.baseDebit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${postedLines.baseCredit}), 0)`,
        })
        .from(accounts)
        .leftJoin(postedLines, eq(postedLines.accountId, accounts.id))
        .where(eq(accounts.organizationId, actor.organizationId))
        .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
        .orderBy(accounts.code);

      return aggregated.map((row) => {
        const debit = Money.of(row.totalDebit, baseCurrency);
        const credit = Money.of(row.totalCredit, baseCurrency);
        const side = normalBalanceSide(row.type);
        const balance = side === "DEBIT" ? debit.subtract(credit) : credit.subtract(debit);
        return {
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          type: row.type,
          balance: balance.toString(),
          totalDebit: debit.toString(),
          totalCredit: credit.toString(),
        };
      });
    });
  },

  async listJournalEntries(actor: Actor, opts: { limit?: number; offset?: number } = {}) {
    assertPermission(actor, "journal:read");
    const { limit = 50, offset = 0 } = opts;
    return withTenant(actor.organizationId, async (tx) => {
      const entries = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.organizationId, actor.organizationId))
        .orderBy(desc(journalEntries.postingDate), desc(journalEntries.entryNumber))
        .limit(limit)
        .offset(offset);

      const linesByEntry = await loadLinesForEntries(
        tx,
        actor.organizationId,
        entries.map((e) => e.id),
      );

      return entries.map((entry) => ({ ...entry, lines: linesByEntry.get(entry.id) ?? [] }));
    });
  },

  async getJournalEntry(actor: Actor, entryId: string) {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.organizationId, actor.organizationId)));
      if (!entry) return undefined;

      // Sequential, not Promise.all: these all run on the same
      // transaction-bound connection, which can only process one query at
      // a time (node-postgres deprecation warning otherwise).
      const linesByEntry = await loadLinesForEntries(tx, actor.organizationId, [entry.id]);
      const reversalOfRows = entry.reversalOfId
        ? await tx.select().from(journalEntries).where(eq(journalEntries.id, entry.reversalOfId))
        : [];
      const reversedByRows = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.reversalOfId, entry.id));

      return {
        ...entry,
        lines: linesByEntry.get(entry.id) ?? [],
        reversalOf: reversalOfRows[0] ?? null,
        reversedBy: reversedByRows[0] ?? null,
      };
    });
  },
};
