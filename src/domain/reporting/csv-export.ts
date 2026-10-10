import type { BalanceSheetReport, CashFlowStatement, ProfitAndLossReport } from "./financial-statements";

/**
 * A minimal, dependency-free CSV export for each report — the low-effort
 * baseline this slice includes; PDF/Excel export and the full report
 * builder are Phase 5 Slice 2 (see docs/roadmap.md). Every amount is
 * exported as the exact decimal string already computed elsewhere in this
 * module — never re-derived or reformatted through a float.
 */
function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n") + "\r\n";
}

export function profitAndLossToCsv(report: ProfitAndLossReport): string {
  const rows: string[][] = [];
  const hasComparison = report.totalRevenueComparison !== undefined;
  rows.push(hasComparison ? ["Section", "Code", "Account", "Amount", "Comparison", "Variance"] : ["Section", "Code", "Account", "Amount"]);

  for (const line of report.revenue) {
    rows.push(
      hasComparison
        ? ["Revenue", line.code, line.name, line.amount, line.comparisonAmount ?? "", line.variance ?? ""]
        : ["Revenue", line.code, line.name, line.amount],
    );
  }
  rows.push(
    hasComparison
      ? ["", "", "Total Revenue", report.totalRevenue, report.totalRevenueComparison ?? "", ""]
      : ["", "", "Total Revenue", report.totalRevenue],
  );

  for (const line of report.expenses) {
    rows.push(
      hasComparison
        ? ["Expenses", line.code, line.name, line.amount, line.comparisonAmount ?? "", line.variance ?? ""]
        : ["Expenses", line.code, line.name, line.amount],
    );
  }
  rows.push(
    hasComparison
      ? ["", "", "Total Expenses", report.totalExpenses, report.totalExpensesComparison ?? "", ""]
      : ["", "", "Total Expenses", report.totalExpenses],
  );

  rows.push(
    hasComparison
      ? ["", "", "Net Profit", report.netProfit, report.netProfitComparison ?? "", report.netProfitVariance ?? ""]
      : ["", "", "Net Profit", report.netProfit],
  );

  return toCsv(rows);
}

export function balanceSheetToCsv(report: BalanceSheetReport): string {
  const rows: string[][] = [];
  const hasComparison = report.totalAssetsComparison !== undefined;
  rows.push(hasComparison ? ["Section", "Code", "Account", "Amount", "Comparison"] : ["Section", "Code", "Account", "Amount"]);

  const section = (label: string, lines: BalanceSheetReport["assets"]) => {
    for (const line of lines) {
      rows.push(
        hasComparison
          ? [label, line.code ?? "", line.name, line.amount, line.comparisonAmount ?? ""]
          : [label, line.code ?? "", line.name, line.amount],
      );
    }
  };

  section("Assets", report.assets);
  rows.push(hasComparison ? ["", "", "Total Assets", report.totalAssets, report.totalAssetsComparison ?? ""] : ["", "", "Total Assets", report.totalAssets]);

  section("Liabilities", report.liabilities);
  rows.push(
    hasComparison
      ? ["", "", "Total Liabilities", report.totalLiabilities, report.totalLiabilitiesComparison ?? ""]
      : ["", "", "Total Liabilities", report.totalLiabilities],
  );

  section("Equity", report.equity);
  rows.push(
    hasComparison
      ? ["", "", "Total Equity", report.totalEquity, report.totalEquityComparison ?? ""]
      : ["", "", "Total Equity", report.totalEquity],
  );

  rows.push(
    hasComparison
      ? [
          "",
          "",
          "Total Liabilities + Equity",
          report.totalLiabilitiesAndEquity,
          report.totalLiabilitiesAndEquityComparison ?? "",
        ]
      : ["", "", "Total Liabilities + Equity", report.totalLiabilitiesAndEquity],
  );
  rows.push(["", "", "Balanced?", report.isBalanced ? "Yes" : "No (see difference)"]);

  return toCsv(rows);
}

export function cashFlowToCsv(report: CashFlowStatement): string {
  const rows: string[][] = [["Section", "Code", "Account", "Amount"]];
  rows.push(["Operating Activities", "", "Net Profit", report.netProfit]);
  for (const line of report.operatingAdjustments) {
    rows.push(["Operating Activities", line.code, line.name, line.amount]);
  }
  rows.push(["", "", "Net Cash from Operating Activities", report.netCashFromOperating]);

  for (const line of report.investingActivities) {
    rows.push(["Investing Activities", line.code, line.name, line.amount]);
  }
  rows.push(["", "", "Net Cash from Investing Activities", report.netCashFromInvesting]);

  for (const line of report.financingActivities) {
    rows.push(["Financing Activities", line.code, line.name, line.amount]);
  }
  rows.push(["", "", "Net Cash from Financing Activities", report.netCashFromFinancing]);

  rows.push(["", "", "Net Change in Cash", report.netChangeInCash]);
  rows.push(["", "", "Beginning Cash", report.beginningCash]);
  rows.push(["", "", "Ending Cash (computed)", report.endingCashComputed]);
  rows.push(["", "", "Ending Cash (actual)", report.endingCashActual]);
  rows.push(["", "", "Reconciles?", report.reconciles ? "Yes" : "No"]);

  return toCsv(rows);
}
