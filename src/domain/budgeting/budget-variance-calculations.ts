import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Pure calculation layer for Budget vs. Actual — the mirror of
 * `financial-statements.ts`'s split between calculation and
 * `reporting-service.ts`'s database access, same reasoning: these
 * functions are unit-testable against hand-computed inputs with no
 * database. Inputs are already normal-balance-signed decimal strings
 * (`budgetLines.amount` and `sumPostedActivityByAccount`'s rows run
 * through `normalSignedBalance`, same convention as every financial
 * statement) — never a raw debit/credit pair, so a budget figure and an
 * actual figure are always directly comparable with no sign-flipping here.
 */

export interface BudgetVarianceAccountRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subType: string | null;
}

export interface BudgetVarianceLine {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Normal-balance-signed decimal string — "0.0000" when no budget line exists for this account/period/dimension (see this module's doc comment). */
  budgetAmount: string;
  /** Normal-balance-signed decimal string — "0.0000" when no posted activity exists for this account/period/dimension. */
  actualAmount: string;
  /** `actualAmount - budgetAmount`. Positive means actual ran ahead of budget in the account's own normal direction. */
  variance: string;
  /** `variance / budgetAmount * 100`, as a decimal string — `null` when `budgetAmount` is zero (division is meaningless, not just large). */
  variancePercent: string | null;
  /** True when actual activity exists but no budget line was ever entered for this account/period/dimension — flagged per this slice's brief rather than silently dropped or silently shown as a 0%-variance row. */
  unbudgetedActivity: boolean;
}

export interface BudgetVarianceReport {
  currency: string;
  lines: BudgetVarianceLine[];
  totalBudget: string;
  totalActual: string;
  totalVariance: string;
  /** Set by `BudgetVarianceService.getBudgetVsActual`; absent from this module's own pure `buildBudgetVarianceReport` output. */
  budgetId?: string;
  budgetName?: string;
}

const VARIANCE_PERCENT_DECIMAL_PLACES = 2;

/**
 * One row's variance figures. `budgetAmount`/`actualAmount` are already
 * normal-signed decimal strings for the SAME account (so comparing them
 * directly is meaningful regardless of account type).
 */
export function calculateLineVariance(
  budgetAmount: string,
  actualAmount: string,
  currency: string,
): { variance: string; variancePercent: string | null } {
  const budget = Money.of(budgetAmount, currency);
  const actual = Money.of(actualAmount, currency);
  const variance = actual.subtract(budget);

  if (budget.isZero()) {
    return { variance: variance.toString(), variancePercent: null };
  }

  const percent = variance
    .toDecimal()
    .dividedBy(budget.toDecimal())
    .times(100)
    .toDecimalPlaces(VARIANCE_PERCENT_DECIMAL_PLACES, Decimal.ROUND_HALF_EVEN);

  return { variance: variance.toString(), variancePercent: percent.toFixed(VARIANCE_PERCENT_DECIMAL_PLACES) };
}

/**
 * Builds the full Budget vs. Actual report from the already-fetched budget
 * and actual rows for one account set. Reconciliation rule (this slice's
 * non-negotiable): the UNION of every account that appears in either side
 * is reported — an account with a budget line and zero actual activity
 * still gets a row (full variance, not a missing one), and an account with
 * actual activity but no budget line still gets a row (flagged via
 * `unbudgetedActivity`, not dropped).
 */
export function buildBudgetVarianceReport(
  accounts: BudgetVarianceAccountRow[],
  budgetByAccount: Map<string, string>,
  actualByAccount: Map<string, string>,
  currency: string,
): BudgetVarianceReport {
  const accountIds = new Set<string>([...budgetByAccount.keys(), ...actualByAccount.keys()]);
  const accountById = new Map(accounts.map((a) => [a.accountId, a]));

  const lines: BudgetVarianceLine[] = [];
  let totalBudget = Money.zero(currency);
  let totalActual = Money.zero(currency);

  for (const accountId of accountIds) {
    const account = accountById.get(accountId);
    if (!account) continue; // Defensive: an id with no matching account row is dropped rather than rendered with blanks.

    const budgetAmount = budgetByAccount.get(accountId) ?? "0.0000";
    const actualAmount = actualByAccount.get(accountId) ?? "0.0000";
    const { variance, variancePercent } = calculateLineVariance(budgetAmount, actualAmount, currency);

    totalBudget = totalBudget.add(Money.of(budgetAmount, currency));
    totalActual = totalActual.add(Money.of(actualAmount, currency));

    lines.push({
      accountId,
      code: account.code,
      name: account.name,
      type: account.type,
      budgetAmount: Money.of(budgetAmount, currency).toString(),
      actualAmount: Money.of(actualAmount, currency).toString(),
      variance,
      variancePercent,
      unbudgetedActivity: !budgetByAccount.has(accountId) && actualByAccount.has(accountId),
    });
  }

  lines.sort((a, b) => a.code.localeCompare(b.code));

  return {
    currency,
    lines,
    totalBudget: totalBudget.toString(),
    totalActual: totalActual.toString(),
    totalVariance: totalActual.subtract(totalBudget).toString(),
  };
}
