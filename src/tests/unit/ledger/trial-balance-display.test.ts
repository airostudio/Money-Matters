import { describe, expect, it } from "vitest";
import { resolveTrialBalanceColumn } from "@/domain/ledger/trial-balance-presentation";
import type { TrialBalanceRow } from "@/domain/ledger/ledger-service";

/**
 * Regression test for a real bug found via browser smoke-testing the
 * Trial Balance page: it double-negated credit-normal accounts with a
 * normal (positive) balance, rendering a genuine $1,650 credit as -$1,650
 * in red. Exercises the real presentation logic
 * (src/domain/ledger/trial-balance-presentation.ts), not a copy of it, so
 * a future edit to that module can't silently drift from this test.
 */
const row = (type: TrialBalanceRow["type"], balance: string): TrialBalanceRow => ({
  accountId: type,
  code: "0000",
  name: type,
  type,
  balance,
  totalDebit: "0.0000",
  totalCredit: "0.0000",
});

describe("resolveTrialBalanceColumn", () => {
  it("shows a credit-normal account's normal (positive) balance in the credit column, not negated", () => {
    const { column, magnitude } = resolveTrialBalanceColumn(row("REVENUE", "1650.0000"), "AUD");
    expect(column).toBe("CREDIT");
    expect(magnitude.toString()).toBe("1650.0000");
    expect(magnitude.isNegative()).toBe(false);
  });

  it("shows a debit-normal account's normal (positive) balance in the debit column", () => {
    const { column, magnitude } = resolveTrialBalanceColumn(row("ASSET", "1650.0000"), "AUD");
    expect(column).toBe("DEBIT");
    expect(magnitude.toString()).toBe("1650.0000");
  });

  it("flips a contra-normal balance to the opposite column, still as a positive magnitude", () => {
    // An asset account that has gone net-credit (e.g. overdrawn) — normal
    // side is DEBIT, but the signed balance is negative.
    const { column, magnitude } = resolveTrialBalanceColumn(row("ASSET", "-200.0000"), "AUD");
    expect(column).toBe("CREDIT");
    expect(magnitude.toString()).toBe("200.0000");
    expect(magnitude.isNegative()).toBe(false);
  });

  it("nets to zero after an offsetting reversal, in the normal-side column", () => {
    const { column, magnitude } = resolveTrialBalanceColumn(row("REVENUE", "0.0000"), "AUD");
    expect(column).toBe("CREDIT");
    expect(magnitude.isZero()).toBe(true);
  });
});
