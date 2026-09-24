import { and, asc, eq, gte, lte, ne } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  bills,
  expenseClaims,
  journalEntries,
  journalLines,
  organizations,
  payments,
  supplierCreditNotes,
  supplierPayments,
  invoices,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { Money } from "@/domain/money/money";
import { sumPostedActivityByAccount, type AccountActivitySum } from "@/domain/ledger/gl-aggregation";
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildProfitAndLoss,
  normalSignedBalance,
  type AccountAmount,
  type BalanceSheetReport,
  type CashFlowStatement,
  type NonCashAccountMovement,
  type ProfitAndLossReport,
  type RetainedEarningsSplit,
} from "./financial-statements";

export interface PeriodRange {
  from: Date;
  to: Date;
}

async function loadOrgCurrency(tx: TenantDb, organizationId: string): Promise<string> {
  const [org] = await tx
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return org?.baseCurrency ?? "AUD";
}

function toAccountAmounts(rows: AccountActivitySum[]): AccountAmount[] {
  return rows.map((row) => ({
    accountId: row.accountId,
    code: row.code,
    name: row.name,
    type: row.type,
    subType: row.subType,
    totalDebit: row.totalDebit,
    totalCredit: row.totalCredit,
  }));
}

function netProfitFromRows(rows: AccountActivitySum[], currency: string): Money {
  const revenue = rows
    .filter((r) => r.type === "REVENUE")
    .reduce((sum, r) => sum.add(normalSignedBalance(r, currency)), Money.zero(currency));
  const expenses = rows
    .filter((r) => r.type === "EXPENSE")
    .reduce((sum, r) => sum.add(normalSignedBalance(r, currency)), Money.zero(currency));
  return revenue.subtract(expenses);
}

function dayBefore(date: Date): Date {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * Splits cumulative net profit as of `asOfDate` into "prior fiscal years" vs.
 * "current fiscal year to date" for the Balance Sheet's Retained
 * Earnings/Current Year Earnings lines — see `buildBalanceSheet`'s doc
 * comment for why this split exists at all. The fiscal year is treated as
 * the calendar year (Jan 1 – Dec 31) for this slice: there is no
 * organization-level "fiscal year start month" setting anywhere in the
 * schema today, and a true configurable one belongs with Phase 9's
 * period-lock/close workflow rather than being invented here. Documented in
 * docs/accounting-engine.md.
 */
async function getRetainedEarningsSplit(
  tx: TenantDb,
  organizationId: string,
  asOfDate: Date,
  currency: string,
): Promise<RetainedEarningsSplit> {
  const fiscalYearStart = new Date(Date.UTC(asOfDate.getUTCFullYear(), 0, 1));
  // Sequential, not Promise.all — these share one transaction-bound
  // connection, which can only run one query at a time (see
  // LedgerService.getJournalEntry's identical note).
  const priorRows = await sumPostedActivityByAccount(tx, organizationId, { to: dayBefore(fiscalYearStart) });
  const currentYearRows = await sumPostedActivityByAccount(tx, organizationId, {
    from: fiscalYearStart,
    to: asOfDate,
  });

  return {
    priorPeriods: netProfitFromRows(priorRows, currency).toString(),
    currentYear: netProfitFromRows(currentYearRows, currency).toString(),
  };
}

async function getCashAccountIds(tx: TenantDb, organizationId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ glAccountId: bankAccounts.glAccountId })
    .from(bankAccounts)
    .where(eq(bankAccounts.organizationId, organizationId));
  return new Set(rows.map((r) => r.glAccountId));
}

export interface SourceDocumentRef {
  type: "INVOICE" | "BILL" | "SUPPLIER_CREDIT_NOTE" | "EXPENSE_CLAIM" | "CUSTOMER_PAYMENT" | "SUPPLIER_PAYMENT";
  id: string;
  label: string;
}

/**
 * Master spec §32's drill-down chain ends at "the source document" — the
 * invoice/bill/expense claim/credit note (or payment) whose approval is what
 * actually posted this journal entry. Every one of those tables carries its
 * own `journalEntryId` (set once, by that entity's own posting step — see
 * `docs/roadmap.md`'s Phase 3/4 sections), so this is a reverse lookup
 * across the handful of tables that can be a journal's source, not a new
 * link column. Queried sequentially, not with `Promise.all` — see
 * `LedgerService.getJournalEntry`'s identical note on why every query here
 * shares one transaction-bound connection.
 */
async function resolveSourceDocument(
  tx: TenantDb,
  organizationId: string,
  journalEntryId: string,
): Promise<SourceDocumentRef | null> {
  const [invoiceRow] = await tx
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(and(eq(invoices.organizationId, organizationId), eq(invoices.journalEntryId, journalEntryId)));
  if (invoiceRow) return { type: "INVOICE", id: invoiceRow.id, label: invoiceRow.invoiceNumber };

  const [billRow] = await tx
    .select({ id: bills.id, billNumber: bills.billNumber })
    .from(bills)
    .where(and(eq(bills.organizationId, organizationId), eq(bills.journalEntryId, journalEntryId)));
  if (billRow) return { type: "BILL", id: billRow.id, label: billRow.billNumber };

  const [creditNoteRow] = await tx
    .select({ id: supplierCreditNotes.id, creditNoteNumber: supplierCreditNotes.creditNoteNumber })
    .from(supplierCreditNotes)
    .where(
      and(
        eq(supplierCreditNotes.organizationId, organizationId),
        eq(supplierCreditNotes.journalEntryId, journalEntryId),
      ),
    );
  if (creditNoteRow) {
    return { type: "SUPPLIER_CREDIT_NOTE", id: creditNoteRow.id, label: creditNoteRow.creditNoteNumber };
  }

  const [expenseClaimRow] = await tx
    .select({ id: expenseClaims.id, claimNumber: expenseClaims.claimNumber })
    .from(expenseClaims)
    .where(
      and(eq(expenseClaims.organizationId, organizationId), eq(expenseClaims.journalEntryId, journalEntryId)),
    );
  if (expenseClaimRow) return { type: "EXPENSE_CLAIM", id: expenseClaimRow.id, label: expenseClaimRow.claimNumber };

  const [paymentRow] = await tx
    .select({ id: payments.id, reference: payments.reference, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.journalEntryId, journalEntryId)));
  if (paymentRow) {
    return {
      type: "CUSTOMER_PAYMENT",
      id: paymentRow.id,
      label: paymentRow.reference || `Payment received`,
    };
  }

  const [supplierPaymentRow] = await tx
    .select({ id: supplierPayments.id, reference: supplierPayments.reference })
    .from(supplierPayments)
    .where(
      and(
        eq(supplierPayments.organizationId, organizationId),
        eq(supplierPayments.journalEntryId, journalEntryId),
      ),
    );
  if (supplierPaymentRow) {
    return {
      type: "SUPPLIER_PAYMENT",
      id: supplierPaymentRow.id,
      label: supplierPaymentRow.reference || "Payment made",
    };
  }

  return null;
}

export interface AccountTransactionRow {
  journalLineId: string;
  journalEntryId: string;
  entryNumber: string;
  postingDate: Date;
  memo: string | null;
  status: "DRAFT" | "POSTED" | "REVERSED";
  debit: string;
  credit: string;
  sourceDocument: SourceDocumentRef | null;
}

export const ReportingService = {
  /**
   * Profit & Loss (Income Statement) for `current`, optionally alongside a
   * `comparison` period. Read-only: only ever queries
   * `sumPostedActivityByAccount`, never writes.
   */
  async getProfitAndLoss(
    actor: Actor,
    current: PeriodRange,
    comparison?: PeriodRange,
  ): Promise<ProfitAndLossReport> {
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const currency = await loadOrgCurrency(tx, actor.organizationId);
      const currentRows = await sumPostedActivityByAccount(tx, actor.organizationId, current);
      const comparisonRows = comparison
        ? await sumPostedActivityByAccount(tx, actor.organizationId, comparison)
        : undefined;

      return buildProfitAndLoss(toAccountAmounts(currentRows), currency, comparisonRows && toAccountAmounts(comparisonRows));
    });
  },

  /** Balance Sheet as of `asOfDate`, optionally alongside a `comparisonAsOfDate`. */
  async getBalanceSheet(
    actor: Actor,
    asOfDate: Date,
    comparisonAsOfDate?: Date,
  ): Promise<BalanceSheetReport> {
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const currency = await loadOrgCurrency(tx, actor.organizationId);
      const currentRows = await sumPostedActivityByAccount(tx, actor.organizationId, { to: asOfDate });
      const retainedEarnings = await getRetainedEarningsSplit(tx, actor.organizationId, asOfDate, currency);

      let comparison: { rows: AccountAmount[]; retainedEarnings: RetainedEarningsSplit } | undefined;
      if (comparisonAsOfDate) {
        const comparisonRows = await sumPostedActivityByAccount(tx, actor.organizationId, {
          to: comparisonAsOfDate,
        });
        const comparisonRetainedEarnings = await getRetainedEarningsSplit(
          tx,
          actor.organizationId,
          comparisonAsOfDate,
          currency,
        );
        comparison = { rows: toAccountAmounts(comparisonRows), retainedEarnings: comparisonRetainedEarnings };
      }

      const report = buildBalanceSheet(toAccountAmounts(currentRows), currency, retainedEarnings, comparison);
      report.asOfDate = asOfDate.toISOString();
      report.comparisonAsOfDate = comparisonAsOfDate?.toISOString();
      return report;
    });
  },

  /**
   * Cash Flow Statement for `period`, indirect method — see
   * `financial-statements.ts`'s doc comment on `classifyNonCashAccount` for
   * why the direct method isn't used. `cashAccountIds` come from
   * `bank_accounts.glAccountId` — the same explicit GL-account link the
   * banking module already uses to mean "this account is real cash", rather
   * than a free-text `subType` guess.
   */
  async getCashFlowStatement(actor: Actor, period: PeriodRange): Promise<CashFlowStatement> {
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const currency = await loadOrgCurrency(tx, actor.organizationId);
      const cashAccountIds = await getCashAccountIds(tx, actor.organizationId);

      // Sequential — see the identical note in `getRetainedEarningsSplit`.
      const periodRows = await sumPostedActivityByAccount(tx, actor.organizationId, period);
      const startRows = await sumPostedActivityByAccount(tx, actor.organizationId, {
        to: dayBefore(period.from),
      });
      const endRows = await sumPostedActivityByAccount(tx, actor.organizationId, { to: period.to });

      const netProfit = netProfitFromRows(periodRows, currency);

      const startByAccount = new Map(startRows.map((r) => [r.accountId, r]));
      let cashStart = Money.zero(currency);
      let cashEnd = Money.zero(currency);
      const nonCashMovements: NonCashAccountMovement[] = [];

      for (const endRow of endRows) {
        if (endRow.type === "REVENUE" || endRow.type === "EXPENSE") continue;
        const startRow = startByAccount.get(endRow.accountId) ?? {
          ...endRow,
          totalDebit: "0",
          totalCredit: "0",
        };

        if (cashAccountIds.has(endRow.accountId)) {
          cashStart = cashStart.add(normalSignedBalance(startRow, currency));
          cashEnd = cashEnd.add(normalSignedBalance(endRow, currency));
          continue;
        }

        nonCashMovements.push({
          accountId: endRow.accountId,
          code: endRow.code,
          name: endRow.name,
          type: endRow.type,
          subType: endRow.subType,
          startBalance: normalSignedBalance(startRow, currency).toString(),
          endBalance: normalSignedBalance(endRow, currency).toString(),
        });
      }

      return buildCashFlowStatement(
        netProfit.toString(),
        nonCashMovements,
        { startBalance: cashStart.toString(), endBalance: cashEnd.toString() },
        currency,
      );
    });
  },

  /**
   * Drill-down data for a single account: master spec §32's "Revenue →
   * Account → Transaction → Invoice → Source Document" chain, one hop past
   * the account itself. Every posted line for `accountId` within `range`,
   * each resolved to the source document (if any) that caused the posting.
   * Gated on `journal:read`, not `financial_report:read` — this page is
   * reachable from the Trial Balance too (which has always been
   * `journal:read`-gated), and browsing one account's own postings isn't
   * more sensitive than the Journals list every `journal:read` holder can
   * already see; it's the aggregate P&L/Balance Sheet/Cash Flow VIEWS that
   * get the stricter gate.
   */
  async getAccountTransactions(
    actor: Actor,
    accountId: string,
    range: PeriodRange,
  ): Promise<AccountTransactionRow[]> {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({
          journalLineId: journalLines.id,
          journalEntryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          postingDate: journalEntries.postingDate,
          memo: journalLines.memo,
          status: journalEntries.status,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.organizationId, actor.organizationId),
            eq(journalLines.accountId, accountId),
            ne(journalEntries.status, "DRAFT"),
            gte(journalEntries.postingDate, range.from),
            lte(journalEntries.postingDate, range.to),
          ),
        )
        .orderBy(asc(journalEntries.postingDate), asc(journalEntries.entryNumber));

      // Sequential — same transaction-bound connection as everywhere else
      // in this codebase (see LedgerService.getJournalEntry's identical note).
      const result: AccountTransactionRow[] = [];
      for (const row of rows) {
        const sourceDocument = await resolveSourceDocument(tx, actor.organizationId, row.journalEntryId);
        result.push({ ...row, sourceDocument });
      }
      return result;
    });
  },

  /**
   * The reverse "which invoice/bill/etc. caused this posting" lookup, for
   * the Journal Entry detail page (`/accounting/journals/[entryId]`) — the
   * last hop of master spec §32's drill-down chain, reachable from a plain
   * journal entry too, not only from a financial statement. Gated on
   * `journal:read` (what that page already requires) rather than
   * `financial_report:read`, since every role that can see a journal
   * entry's lines can just as well see which document caused it.
   */
  async getSourceDocumentForJournalEntry(actor: Actor, journalEntryId: string): Promise<SourceDocumentRef | null> {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, (tx) => resolveSourceDocument(tx, actor.organizationId, journalEntryId));
  },

  /** Confirms `accountId` belongs to the actor's organization — used to validate a drill-down link's accountId before querying. Gated like `getAccountTransactions`, see its comment. */
  async getAccount(actor: Actor, accountId: string) {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },
};
