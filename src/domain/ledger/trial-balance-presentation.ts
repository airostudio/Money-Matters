import { normalBalanceSide, type TrialBalanceRow } from "./ledger-service";
import { Money } from "@/domain/money/money";

export interface TrialBalanceColumnRow {
  row: TrialBalanceRow;
  column: "DEBIT" | "CREDIT";
  magnitude: Money;
}

/**
 * `row.balance` is normal-balance-signed (positive means "in the account's
 * own normal direction" — see docs/accounting-engine.md). A trial balance
 * display instead needs "which column, and what magnitude": an account
 * that has gone the *opposite* way from its normal balance (e.g. an
 * overdrawn bank account) still needs to appear as a positive number, just
 * in the other column. Resolving that once here means the row rendering
 * and the column totals (src/app/[orgSlug]/accounting/trial-balance) can't
 * disagree with each other — and it's unit-testable without a database.
 *
 * A prior version of this logic negated every non-debit-column balance
 * unconditionally, which silently turned a genuine positive credit balance
 * into a displayed negative number — caught via browser smoke-testing, not
 * a type error. See src/tests/unit/ledger/trial-balance-display.test.ts.
 */
export function resolveTrialBalanceColumn(row: TrialBalanceRow, currency: string): TrialBalanceColumnRow {
  const signedBalance = Money.of(row.balance, currency);
  const normalSide = normalBalanceSide(row.type);
  const isNormalDirection = signedBalance.isPositive() || signedBalance.isZero();
  const column = isNormalDirection ? normalSide : normalSide === "DEBIT" ? "CREDIT" : "DEBIT";
  const magnitude = signedBalance.isNegative() ? signedBalance.negate() : signedBalance;
  return { row, column, magnitude };
}
