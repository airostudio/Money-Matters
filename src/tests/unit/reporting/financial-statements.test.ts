import { describe, expect, it } from "vitest";
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildProfitAndLoss,
  classifyNonCashAccount,
  type AccountAmount,
} from "@/domain/reporting/financial-statements";

const CURRENCY = "AUD";

function account(overrides: Partial<AccountAmount> & Pick<AccountAmount, "accountId" | "type">): AccountAmount {
  return {
    code: overrides.accountId,
    name: overrides.accountId,
    subType: null,
    totalDebit: "0",
    totalCredit: "0",
    ...overrides,
  };
}

describe("buildProfitAndLoss", () => {
  it("computes revenue, expense subtotals and net profit from hand-computed inputs", () => {
    const rows: AccountAmount[] = [
      account({ accountId: "sales", type: "REVENUE", code: "4000", name: "Sales", totalCredit: "10000.0000" }),
      account({
        accountId: "interest",
        type: "REVENUE",
        code: "4100",
        name: "Interest Income",
        totalCredit: "500.0000",
      }),
      account({ accountId: "rent", type: "EXPENSE", code: "6000", name: "Rent", totalDebit: "2000.0000" }),
      account({ accountId: "wages", type: "EXPENSE", code: "6100", name: "Wages", totalDebit: "3000.0000" }),
      // An unrelated balance-sheet account must never leak into a P&L.
      account({ accountId: "bank", type: "ASSET", code: "1000", name: "Bank", totalDebit: "999.0000" }),
    ];

    const report = buildProfitAndLoss(rows, CURRENCY);

    expect(report.revenue).toHaveLength(2);
    expect(report.totalRevenue).toBe("10500.0000");
    expect(report.expenses).toHaveLength(2);
    expect(report.totalExpenses).toBe("5000.0000");
    expect(report.netProfit).toBe("5500.0000");
  });

  it("computes a comparison period and per-line variance", () => {
    const current: AccountAmount[] = [
      account({ accountId: "sales", type: "REVENUE", code: "4000", name: "Sales", totalCredit: "12000.0000" }),
      account({ accountId: "rent", type: "EXPENSE", code: "6000", name: "Rent", totalDebit: "2000.0000" }),
    ];
    const comparison: AccountAmount[] = [
      account({ accountId: "sales", type: "REVENUE", code: "4000", name: "Sales", totalCredit: "10000.0000" }),
      account({ accountId: "rent", type: "EXPENSE", code: "6000", name: "Rent", totalDebit: "2000.0000" }),
    ];

    const report = buildProfitAndLoss(current, CURRENCY, comparison);

    expect(report.totalRevenue).toBe("12000.0000");
    expect(report.totalRevenueComparison).toBe("10000.0000");
    expect(report.netProfit).toBe("10000.0000");
    expect(report.netProfitComparison).toBe("8000.0000");
    expect(report.netProfitVariance).toBe("2000.0000");

    const salesLine = report.revenue.find((l) => l.accountId === "sales")!;
    expect(salesLine.variance).toBe("2000.0000");
  });

  it("includes an account with comparison-only activity, at zero for the current period", () => {
    const current: AccountAmount[] = [];
    const comparison: AccountAmount[] = [
      account({ accountId: "onceoff", type: "REVENUE", code: "4900", name: "One-off Sale", totalCredit: "500.0000" }),
    ];
    const report = buildProfitAndLoss(current, CURRENCY, comparison);
    expect(report.revenue).toHaveLength(1);
    expect(report.revenue[0]!.amount).toBe("0.0000");
    expect(report.revenue[0]!.comparisonAmount).toBe("500.0000");
  });

  it("omits accounts with zero activity in both periods", () => {
    const rows: AccountAmount[] = [account({ accountId: "unused", type: "EXPENSE", code: "6900", name: "Unused" })];
    const report = buildProfitAndLoss(rows, CURRENCY);
    expect(report.expenses).toHaveLength(0);
  });
});

describe("buildBalanceSheet", () => {
  it("verifies Assets = Liabilities + Equity, including computed retained earnings", () => {
    const rows: AccountAmount[] = [
      account({ accountId: "bank", type: "ASSET", code: "1000", name: "Bank", totalDebit: "15500.0000" }),
      account({ accountId: "ap", type: "LIABILITY", code: "2000", name: "Accounts Payable", totalCredit: "5000.0000" }),
      account({ accountId: "capital", type: "EQUITY", code: "3000", name: "Owner's Capital", totalCredit: "5000.0000" }),
    ];

    // Net profit of 5500 (matching the P&L test above) hasn't been closed to
    // equity anywhere in the ledger — it's carried as the computed
    // "Current Year Earnings" line instead.
    const report = buildBalanceSheet(rows, CURRENCY, { priorPeriods: "0.0000", currentYear: "5500.0000" });

    expect(report.totalAssets).toBe("15500.0000");
    expect(report.totalLiabilities).toBe("5000.0000");
    expect(report.totalEquity).toBe("10500.0000"); // 5000 capital + 5500 current year earnings
    expect(report.totalLiabilitiesAndEquity).toBe("15500.0000");
    expect(report.difference).toBe("0.0000");
    expect(report.isBalanced).toBe(true);

    const currentYearLine = report.equity.find((l) => l.name === "Current Year Earnings")!;
    expect(currentYearLine.amount).toBe("5500.0000");
    expect(currentYearLine.isComputed).toBe(true);
  });

  it("flags an unbalanced statement rather than hiding the discrepancy", () => {
    const rows: AccountAmount[] = [
      account({ accountId: "bank", type: "ASSET", code: "1000", name: "Bank", totalDebit: "1000.0000" }),
      account({ accountId: "ap", type: "LIABILITY", code: "2000", name: "AP", totalCredit: "5000.0000" }),
    ];
    const report = buildBalanceSheet(rows, CURRENCY, { priorPeriods: "0.0000", currentYear: "0.0000" });
    expect(report.isBalanced).toBe(false);
    expect(report.difference).toBe("-4000.0000");
  });

  it("supports a comparison as-of date with its own balance check", () => {
    const current: AccountAmount[] = [
      account({ accountId: "bank", type: "ASSET", code: "1000", name: "Bank", totalDebit: "20000.0000" }),
      account({ accountId: "capital", type: "EQUITY", code: "3000", name: "Capital", totalCredit: "10000.0000" }),
    ];
    const comparison: AccountAmount[] = [
      account({ accountId: "bank", type: "ASSET", code: "1000", name: "Bank", totalDebit: "12000.0000" }),
      account({ accountId: "capital", type: "EQUITY", code: "3000", name: "Capital", totalCredit: "10000.0000" }),
    ];

    const report = buildBalanceSheet(
      current,
      CURRENCY,
      { priorPeriods: "0.0000", currentYear: "10000.0000" },
      { rows: comparison, retainedEarnings: { priorPeriods: "0.0000", currentYear: "2000.0000" } },
    );

    expect(report.totalAssetsComparison).toBe("12000.0000");
    expect(report.isBalanced).toBe(true);
    expect(report.isBalancedComparison).toBe(true);
  });
});

describe("classifyNonCashAccount", () => {
  it("classifies equity as financing regardless of subtype", () => {
    expect(classifyNonCashAccount({ type: "EQUITY", subType: null })).toBe("FINANCING");
  });

  it("classifies a non-current liability as financing (a loan/borrowing)", () => {
    expect(classifyNonCashAccount({ type: "LIABILITY", subType: "Non-current Liability" })).toBe("FINANCING");
  });

  it("classifies a current liability as operating working capital", () => {
    expect(classifyNonCashAccount({ type: "LIABILITY", subType: "Current Liability" })).toBe("OPERATING");
    expect(classifyNonCashAccount({ type: "LIABILITY", subType: null })).toBe("OPERATING");
  });

  it("classifies a fixed asset as investing", () => {
    expect(classifyNonCashAccount({ type: "ASSET", subType: "Fixed Asset" })).toBe("INVESTING");
  });

  it("classifies a current/other asset as operating working capital", () => {
    expect(classifyNonCashAccount({ type: "ASSET", subType: "Current Asset" })).toBe("OPERATING");
    expect(classifyNonCashAccount({ type: "ASSET", subType: null })).toBe("OPERATING");
  });
});

describe("buildCashFlowStatement (indirect method)", () => {
  it("reconciles net profit + working-capital changes to the actual change in cash", () => {
    // Net profit 5,000. Accounts Receivable rose 1,000 (uses cash — a sale
    // was made but not yet collected). Accounts Payable rose 500 (source of
    // cash — a bill was incurred but not yet paid). Fixed assets (a laptop)
    // increased by 2,000 (investing, financed some other way this period —
    // this test only asserts the classification and the reconciliation, not
    // how it was financed). Expected net change in cash:
    // operating = 5000 - 1000 (AR up) + 500 (AP up) = 4500
    // investing = -2000 (fixed asset purchase)
    // financing = 0
    // netChangeInCash = 2500
    const movements = [
      {
        accountId: "ar",
        code: "1100",
        name: "Accounts Receivable",
        type: "ASSET" as const,
        subType: "Current Asset",
        startBalance: "3000.0000",
        endBalance: "4000.0000",
      },
      {
        accountId: "ap",
        code: "2000",
        name: "Accounts Payable",
        type: "LIABILITY" as const,
        subType: "Current Liability",
        startBalance: "1000.0000",
        endBalance: "1500.0000",
      },
      {
        accountId: "equipment",
        code: "1520",
        name: "Equipment",
        type: "ASSET" as const,
        subType: "Fixed Asset",
        startBalance: "0.0000",
        endBalance: "2000.0000",
      },
    ];

    const statement = buildCashFlowStatement(
      "5000.0000",
      movements,
      { startBalance: "10000.0000", endBalance: "12500.0000" },
      CURRENCY,
    );

    expect(statement.netCashFromOperating).toBe("4500.0000");
    expect(statement.netCashFromInvesting).toBe("-2000.0000");
    expect(statement.netCashFromFinancing).toBe("0.0000");
    expect(statement.netChangeInCash).toBe("2500.0000");
    expect(statement.endingCashComputed).toBe("12500.0000");
    expect(statement.endingCashActual).toBe("12500.0000");
    expect(statement.reconciles).toBe(true);
  });

  it("flags a reconciliation failure rather than hiding it", () => {
    const statement = buildCashFlowStatement(
      "1000.0000",
      [],
      { startBalance: "5000.0000", endBalance: "9999.0000" },
      CURRENCY,
    );
    // netChangeInCash computed = 1000 (net profit only, no adjustments), so
    // endingCashComputed = 6000, which does not match the actual 9999.
    expect(statement.reconciles).toBe(false);
  });

  it("treats a capital contribution (equity increase) as financing", () => {
    const movements = [
      {
        accountId: "capital",
        code: "3000",
        name: "Owner's Capital",
        type: "EQUITY" as const,
        subType: null,
        startBalance: "0.0000",
        endBalance: "10000.0000",
      },
    ];
    const statement = buildCashFlowStatement(
      "0.0000",
      movements,
      { startBalance: "0.0000", endBalance: "10000.0000" },
      CURRENCY,
    );
    expect(statement.netCashFromFinancing).toBe("10000.0000");
    expect(statement.reconciles).toBe(true);
  });

  it("omits accounts with no movement in the period", () => {
    const movements = [
      {
        accountId: "ar",
        code: "1100",
        name: "Accounts Receivable",
        type: "ASSET" as const,
        subType: "Current Asset",
        startBalance: "500.0000",
        endBalance: "500.0000",
      },
    ];
    const statement = buildCashFlowStatement("0.0000", movements, { startBalance: "0", endBalance: "0" }, CURRENCY);
    expect(statement.operatingAdjustments).toHaveLength(0);
  });
});
