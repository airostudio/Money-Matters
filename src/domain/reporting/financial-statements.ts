import { Money } from "@/domain/money/money";
import { normalBalanceSide } from "@/domain/ledger/ledger-service";
import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Pure calculation layer for Phase 5 Slice 1's financial statements: every
 * function here takes already-fetched account activity (from
 * `src/domain/ledger/gl-aggregation.ts`'s `sumPostedActivityByAccount`, via
 * `ReportingService`) and returns a fully computed report. No database
 * access, no permission checks — those live in `reporting-service.ts`. That
 * split is what makes these unit-testable against hand-computed inputs
 * without a database (see `src/tests/unit/reporting/*`).
 *
 * Every Money computation goes through `src/domain/money`'s Decimal-backed
 * `Money` class — never a JS float — per docs/accounting-engine.md §4, all
 * the way through subtotals and the Balance Sheet equation check.
 */

export interface AccountAmount {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subType: string | null;
  /** Base-currency decimal string — the raw debit/credit sums for the range this row was computed over. */
  totalDebit: string;
  /** Base-currency decimal string. */
  totalCredit: string;
}

/** Normal-balance-signed total: positive means "in the account's own normal direction" — same convention as `TrialBalanceRow.balance`. */
export function normalSignedBalance(
  row: { type: AccountType; totalDebit: string; totalCredit: string },
  currency: string,
): Money {
  const debit = Money.of(row.totalDebit, currency);
  const credit = Money.of(row.totalCredit, currency);
  const side = normalBalanceSide(row.type);
  return side === "DEBIT" ? debit.subtract(credit) : credit.subtract(debit);
}

// ---------------------------------------------------------------------------
// Profit & Loss (Income Statement)
// ---------------------------------------------------------------------------

export interface ProfitAndLossLine {
  accountId: string;
  code: string;
  name: string;
  /** Normal-signed amount for the current period (positive = revenue/expense in its normal direction). */
  amount: string;
  /** Same, for the comparison period, when one was requested. */
  comparisonAmount?: string;
  /** `amount - comparisonAmount`, only present alongside a comparison period. */
  variance?: string;
}

export interface ProfitAndLossReport {
  currency: string;
  revenue: ProfitAndLossLine[];
  totalRevenue: string;
  totalRevenueComparison?: string;
  expenses: ProfitAndLossLine[];
  totalExpenses: string;
  totalExpensesComparison?: string;
  netProfit: string;
  netProfitComparison?: string;
  netProfitVariance?: string;
}

function buildSection(
  type: "REVENUE" | "EXPENSE",
  currentRows: AccountAmount[],
  currency: string,
  comparisonRows?: AccountAmount[],
): { lines: ProfitAndLossLine[]; total: Money; totalComparison?: Money } {
  const currentByAccount = new Map(currentRows.filter((r) => r.type === type).map((r) => [r.accountId, r]));
  const comparisonByAccount = new Map(
    (comparisonRows ?? []).filter((r) => r.type === type).map((r) => [r.accountId, r]),
  );
  const accountIds = new Set([...currentByAccount.keys(), ...comparisonByAccount.keys()]);

  const lines: ProfitAndLossLine[] = [];
  let total = Money.zero(currency);
  let totalComparison = comparisonRows ? Money.zero(currency) : undefined;

  for (const accountId of accountIds) {
    const currentRow = currentByAccount.get(accountId);
    const comparisonRow = comparisonByAccount.get(accountId);
    const amount = currentRow ? normalSignedBalance(currentRow, currency) : Money.zero(currency);
    const comparisonAmount = comparisonRows
      ? comparisonRow
        ? normalSignedBalance(comparisonRow, currency)
        : Money.zero(currency)
      : undefined;

    // Skip an account with no activity in either period — a report should
    // not list every unused REVENUE/EXPENSE account in the chart.
    if (amount.isZero() && (comparisonAmount === undefined || comparisonAmount.isZero())) continue;

    const source = currentRow ?? comparisonRow!;
    total = total.add(amount);
    if (totalComparison && comparisonAmount) totalComparison = totalComparison.add(comparisonAmount);

    lines.push({
      accountId,
      code: source.code,
      name: source.name,
      amount: amount.toString(),
      comparisonAmount: comparisonAmount?.toString(),
      variance: comparisonAmount ? amount.subtract(comparisonAmount).toString() : undefined,
    });
  }

  lines.sort((a, b) => a.code.localeCompare(b.code));
  return { lines, total, totalComparison };
}

export function buildProfitAndLoss(
  currentRows: AccountAmount[],
  currency: string,
  comparisonRows?: AccountAmount[],
): ProfitAndLossReport {
  const revenue = buildSection("REVENUE", currentRows, currency, comparisonRows);
  const expenses = buildSection("EXPENSE", currentRows, currency, comparisonRows);

  const netProfit = revenue.total.subtract(expenses.total);
  const netProfitComparison =
    revenue.totalComparison && expenses.totalComparison
      ? revenue.totalComparison.subtract(expenses.totalComparison)
      : undefined;

  return {
    currency,
    revenue: revenue.lines,
    totalRevenue: revenue.total.toString(),
    totalRevenueComparison: revenue.totalComparison?.toString(),
    expenses: expenses.lines,
    totalExpenses: expenses.total.toString(),
    totalExpensesComparison: expenses.totalComparison?.toString(),
    netProfit: netProfit.toString(),
    netProfitComparison: netProfitComparison?.toString(),
    netProfitVariance: netProfitComparison ? netProfit.subtract(netProfitComparison).toString() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------

export interface BalanceSheetLine {
  /** `null` for the two computed retained-earnings lines, which have no single backing account. */
  accountId: string | null;
  code: string | null;
  name: string;
  amount: string;
  comparisonAmount?: string;
  isComputed?: boolean;
}

export interface RetainedEarningsSplit {
  /** Cumulative net profit from all posted activity strictly before the current fiscal year's start. */
  priorPeriods: string;
  /** Net profit for the current fiscal year, from its start through the report date. */
  currentYear: string;
}

export interface BalanceSheetSnapshot {
  rows: AccountAmount[];
  retainedEarnings: RetainedEarningsSplit;
}

export interface BalanceSheetReport {
  currency: string;
  asOfDate: string;
  comparisonAsOfDate?: string;
  assets: BalanceSheetLine[];
  totalAssets: string;
  totalAssetsComparison?: string;
  liabilities: BalanceSheetLine[];
  totalLiabilities: string;
  totalLiabilitiesComparison?: string;
  equity: BalanceSheetLine[];
  totalEquity: string;
  totalEquityComparison?: string;
  totalLiabilitiesAndEquity: string;
  totalLiabilitiesAndEquityComparison?: string;
  /** Assets − (Liabilities + Equity). Zero means the statement balances. */
  difference: string;
  isBalanced: boolean;
  differenceComparison?: string;
  isBalancedComparison?: boolean;
}

function buildBalanceSection(
  type: "ASSET" | "LIABILITY" | "EQUITY",
  currentRows: AccountAmount[],
  currency: string,
  comparisonRows?: AccountAmount[],
): { lines: BalanceSheetLine[]; total: Money; totalComparison?: Money } {
  const currentByAccount = new Map(currentRows.filter((r) => r.type === type).map((r) => [r.accountId, r]));
  const comparisonByAccount = new Map(
    (comparisonRows ?? []).filter((r) => r.type === type).map((r) => [r.accountId, r]),
  );
  const accountIds = new Set([...currentByAccount.keys(), ...comparisonByAccount.keys()]);

  const lines: BalanceSheetLine[] = [];
  let total = Money.zero(currency);
  let totalComparison = comparisonRows ? Money.zero(currency) : undefined;

  for (const accountId of accountIds) {
    const currentRow = currentByAccount.get(accountId);
    const comparisonRow = comparisonByAccount.get(accountId);
    const amount = currentRow ? normalSignedBalance(currentRow, currency) : Money.zero(currency);
    const comparisonAmount = comparisonRows
      ? comparisonRow
        ? normalSignedBalance(comparisonRow, currency)
        : Money.zero(currency)
      : undefined;

    if (amount.isZero() && (comparisonAmount === undefined || comparisonAmount.isZero())) continue;

    const source = currentRow ?? comparisonRow!;
    total = total.add(amount);
    if (totalComparison && comparisonAmount) totalComparison = totalComparison.add(comparisonAmount);

    lines.push({
      accountId,
      code: source.code,
      name: source.name,
      amount: amount.toString(),
      comparisonAmount: comparisonAmount?.toString(),
    });
  }

  lines.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
  return { lines, total, totalComparison };
}

/**
 * There is deliberately no period-close process in this codebase yet (see
 * docs/accounting-engine.md and Phase 9's "month-end close workspace") — a
 * REVENUE/EXPENSE account's balance is never zeroed into the ledger's actual
 * "Retained Earnings" system account (`OrganizationService`'s
 * `STARTER_SYSTEM_ACCOUNTS`). Without that, Assets = Liabilities + Equity
 * only holds if the Balance Sheet adds *computed* equity lines for
 * accumulated net profit — the extended accounting equation
 * `Assets = Liabilities + Equity + (Revenue − Expenses)` that already holds
 * by construction from the ledger's own debit=credit invariant. This
 * function builds those two lines (prior-period vs. current-fiscal-year,
 * split for readability the way real accounting software — e.g. "Retained
 * Earnings" vs. "Current Year Earnings" — does), on top of whatever the
 * actual equity accounts hold from direct postings (capital contributions,
 * drawings, or a manual closing entry someone did post).
 */
export function buildBalanceSheet(
  currentRows: AccountAmount[],
  currency: string,
  retainedEarnings: RetainedEarningsSplit,
  comparison?: { rows: AccountAmount[]; retainedEarnings: RetainedEarningsSplit },
): BalanceSheetReport {
  const assets = buildBalanceSection("ASSET", currentRows, currency, comparison?.rows);
  const liabilities = buildBalanceSection("LIABILITY", currentRows, currency, comparison?.rows);
  const equityAccounts = buildBalanceSection("EQUITY", currentRows, currency, comparison?.rows);

  const priorPeriods = Money.of(retainedEarnings.priorPeriods, currency);
  const currentYear = Money.of(retainedEarnings.currentYear, currency);
  const equityLines: BalanceSheetLine[] = [
    ...equityAccounts.lines,
    {
      accountId: null,
      code: null,
      name: "Retained Earnings (prior periods)",
      amount: priorPeriods.toString(),
      comparisonAmount: comparison ? Money.of(comparison.retainedEarnings.priorPeriods, currency).toString() : undefined,
      isComputed: true,
    },
    {
      accountId: null,
      code: null,
      name: "Current Year Earnings",
      amount: currentYear.toString(),
      comparisonAmount: comparison ? Money.of(comparison.retainedEarnings.currentYear, currency).toString() : undefined,
      isComputed: true,
    },
  ];

  const totalEquity = equityAccounts.total.add(priorPeriods).add(currentYear);
  const totalEquityComparison = comparison
    ? (equityAccounts.totalComparison ?? Money.zero(currency))
        .add(Money.of(comparison.retainedEarnings.priorPeriods, currency))
        .add(Money.of(comparison.retainedEarnings.currentYear, currency))
    : undefined;

  const totalLiabilitiesAndEquity = liabilities.total.add(totalEquity);
  const totalLiabilitiesAndEquityComparison =
    liabilities.totalComparison && totalEquityComparison
      ? liabilities.totalComparison.add(totalEquityComparison)
      : undefined;

  const difference = assets.total.subtract(totalLiabilitiesAndEquity);
  const differenceComparison =
    assets.totalComparison && totalLiabilitiesAndEquityComparison
      ? assets.totalComparison.subtract(totalLiabilitiesAndEquityComparison)
      : undefined;

  return {
    currency,
    asOfDate: "",
    assets: assets.lines,
    totalAssets: assets.total.toString(),
    totalAssetsComparison: assets.totalComparison?.toString(),
    liabilities: liabilities.lines,
    totalLiabilities: liabilities.total.toString(),
    totalLiabilitiesComparison: liabilities.totalComparison?.toString(),
    equity: equityLines,
    totalEquity: totalEquity.toString(),
    totalEquityComparison: totalEquityComparison?.toString(),
    totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toString(),
    totalLiabilitiesAndEquityComparison: totalLiabilitiesAndEquityComparison?.toString(),
    difference: difference.toString(),
    isBalanced: difference.isZero(),
    differenceComparison: differenceComparison?.toString(),
    isBalancedComparison: differenceComparison?.isZero(),
  };
}

// ---------------------------------------------------------------------------
// Cash Flow Statement (indirect method)
// ---------------------------------------------------------------------------

/**
 * This codebase has no transaction-level cash-vs-non-cash tagging (the
 * direct method needs "was this specific movement a cash receipt/payment,
 * and for what activity" per line) — building that would mean retrofitting
 * every posting path across Sales/Purchases/Banking/Expenses. The indirect
 * method only needs balance-sheet snapshots the ledger already has: start
 * from Net Profit (from the P&L) and adjust for the period's change in
 * every non-cash balance-sheet account. See docs/accounting-engine.md for
 * the full writeup of this choice.
 */
export type CashFlowClassification = "OPERATING" | "INVESTING" | "FINANCING";

/**
 * Classifies a non-cash balance-sheet account for the indirect method.
 * EQUITY accounts (capital contributions, drawings — there is no formal
 * close, so cumulative net profit is handled separately, not through this
 * classifier) are always Financing. LIABILITY accounts are Financing only
 * when tagged "Non-current Liability" (the onboarding chart-of-accounts
 * template's convention for loans/borrowings — see
 * `src/domain/onboarding/chart-of-accounts-templates.ts`); every other
 * liability (Accounts Payable, GST Payable, accrued liabilities, a credit
 * card) is an Operating working-capital item. ASSET accounts are Investing
 * only when tagged "Fixed Asset"; every other non-cash asset (Accounts
 * Receivable, Inventory/WIP, GST Receivable, prepayments) is Operating. An
 * account with no subtype set defaults to Operating — the standard indirect
 * treatment for a working-capital item the chart of accounts hasn't tagged
 * more specifically.
 */
export function classifyNonCashAccount(account: { type: AccountType; subType: string | null }): CashFlowClassification {
  if (account.type === "EQUITY") return "FINANCING";
  if (account.type === "LIABILITY") return account.subType === "Non-current Liability" ? "FINANCING" : "OPERATING";
  return account.subType === "Fixed Asset" ? "INVESTING" : "OPERATING";
}

export interface NonCashAccountMovement {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subType: string | null;
  /** Normal-balance-signed balance immediately before the period starts. */
  startBalance: string;
  /** Normal-balance-signed balance as of the period end. */
  endBalance: string;
}

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  /** Signed so that positive always means "added cash" this period, regardless of the account's own normal balance. */
  amount: string;
}

export interface CashFlowStatement {
  currency: string;
  netProfit: string;
  operatingAdjustments: CashFlowLine[];
  netCashFromOperating: string;
  investingActivities: CashFlowLine[];
  netCashFromInvesting: string;
  financingActivities: CashFlowLine[];
  netCashFromFinancing: string;
  netChangeInCash: string;
  beginningCash: string;
  /** `beginningCash + netChangeInCash` — should equal `endingCashActual` by the accounting-equation identity below. */
  endingCashComputed: string;
  /** The cash accounts' own actual ledger balance as of the period end — the correctness check. */
  endingCashActual: string;
  /**
   * `endingCashComputed === endingCashActual`. This holds by construction:
   * from Assets = Liabilities + Equity + (Revenue − Expenses) at both the
   * start and end of the period, Cash = Liabilities + Equity + NetProfit −
   * NonCashAssets, so ΔCash = NetProfit + ΔLiabilities + ΔEquity − ΔNonCash
   * Assets — exactly what this function computes. A `false` here would mean
   * either a bug in this calculation or (impossible if `PostingService` is
   * the only posting path) an unbalanced journal somewhere in the ledger.
   */
  reconciles: boolean;
}

export function buildCashFlowStatement(
  netProfit: string,
  nonCashMovements: NonCashAccountMovement[],
  cashMovement: { startBalance: string; endBalance: string },
  currency: string,
): CashFlowStatement {
  const buckets: Record<CashFlowClassification, CashFlowLine[]> = {
    OPERATING: [],
    INVESTING: [],
    FINANCING: [],
  };

  for (const movement of nonCashMovements) {
    const start = Money.of(movement.startBalance, currency);
    const end = Money.of(movement.endBalance, currency);
    const delta = end.subtract(start);
    if (delta.isZero()) continue;

    // ASSET: an increase in a non-cash asset consumes cash. LIABILITY/EQUITY:
    // an increase is a source of cash. Both `delta`s are normal-balance-signed
    // already, so the sign flip only applies to the asset side.
    const cashImpact = movement.type === "ASSET" ? delta.negate() : delta;
    const classification = classifyNonCashAccount(movement);
    buckets[classification].push({
      accountId: movement.accountId,
      code: movement.code,
      name: movement.name,
      amount: cashImpact.toString(),
    });
  }

  const sumLines = (lines: CashFlowLine[]) =>
    lines.reduce((sum, line) => sum.add(Money.of(line.amount, currency)), Money.zero(currency));

  const netProfitMoney = Money.of(netProfit, currency);
  const operatingAdjustmentTotal = sumLines(buckets.OPERATING);
  const netCashFromOperating = netProfitMoney.add(operatingAdjustmentTotal);
  const netCashFromInvesting = sumLines(buckets.INVESTING);
  const netCashFromFinancing = sumLines(buckets.FINANCING);
  const netChangeInCash = netCashFromOperating.add(netCashFromInvesting).add(netCashFromFinancing);

  const beginningCash = Money.of(cashMovement.startBalance, currency);
  const endingCashActual = Money.of(cashMovement.endBalance, currency);
  const endingCashComputed = beginningCash.add(netChangeInCash);

  return {
    currency,
    netProfit: netProfitMoney.toString(),
    operatingAdjustments: buckets.OPERATING,
    netCashFromOperating: netCashFromOperating.toString(),
    investingActivities: buckets.INVESTING,
    netCashFromInvesting: netCashFromInvesting.toString(),
    financingActivities: buckets.FINANCING,
    netCashFromFinancing: netCashFromFinancing.toString(),
    netChangeInCash: netChangeInCash.toString(),
    beginningCash: beginningCash.toString(),
    endingCashComputed: endingCashComputed.toString(),
    endingCashActual: endingCashActual.toString(),
    reconciles: endingCashComputed.equals(endingCashActual),
  };
}
