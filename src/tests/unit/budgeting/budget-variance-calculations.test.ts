import { describe, expect, it } from "vitest";
import { buildBudgetVarianceReport, calculateLineVariance } from "@/domain/budgeting/budget-variance-calculations";

describe("calculateLineVariance", () => {
  it("computes a positive variance ($ and %) when actual exceeds budget", () => {
    const result = calculateLineVariance("1000.00", "1250.00", "AUD");
    expect(result.variance).toBe("250.0000");
    expect(result.variancePercent).toBe("25.00");
  });

  it("computes a negative variance when actual falls short of budget", () => {
    const result = calculateLineVariance("1000.00", "800.00", "AUD");
    expect(result.variance).toBe("-200.0000");
    expect(result.variancePercent).toBe("-20.00");
  });

  it("is exactly zero variance when actual equals budget", () => {
    const result = calculateLineVariance("500.00", "500.00", "AUD");
    expect(result.variance).toBe("0.0000");
    expect(result.variancePercent).toBe("0.00");
  });

  it("returns null variancePercent (never a divide-by-zero) when budget is zero but actual is non-zero", () => {
    const result = calculateLineVariance("0.00", "150.00", "AUD");
    expect(result.variance).toBe("150.0000");
    expect(result.variancePercent).toBeNull();
  });

  it("is exactly zero variance with null percent when both budget and actual are zero", () => {
    const result = calculateLineVariance("0.00", "0.00", "AUD");
    expect(result.variance).toBe("0.0000");
    expect(result.variancePercent).toBeNull();
  });

  it("handles a negative budget with zero actual (e.g. no spend against a planned expense) correctly", () => {
    const result = calculateLineVariance("500.00", "0.00", "AUD");
    expect(result.variance).toBe("-500.0000");
    expect(result.variancePercent).toBe("-100.00");
  });
});

describe("buildBudgetVarianceReport", () => {
  const accounts = [
    { accountId: "rev-1", code: "4000", name: "Sales Revenue", type: "REVENUE" as const, subType: null },
    { accountId: "exp-1", code: "6000", name: "Rent", type: "EXPENSE" as const, subType: null },
    { accountId: "exp-2", code: "6100", name: "Marketing", type: "EXPENSE" as const, subType: null },
  ];

  it("includes a full row (zero actual, full variance) when a budget line exists with no actual activity", () => {
    const budget = new Map([["exp-2", "2000.0000"]]);
    const actual = new Map<string, string>();
    const report = buildBudgetVarianceReport(accounts, budget, actual, "AUD");

    const line = report.lines.find((l) => l.accountId === "exp-2");
    expect(line).toBeDefined();
    expect(line!.budgetAmount).toBe("2000.0000");
    expect(line!.actualAmount).toBe("0.0000");
    expect(line!.variance).toBe("-2000.0000");
    expect(line!.unbudgetedActivity).toBe(false);
  });

  it("includes a full row flagged unbudgetedActivity when actual activity exists with no budget line", () => {
    const budget = new Map<string, string>();
    const actual = new Map([["exp-1", "850.0000"]]);
    const report = buildBudgetVarianceReport(accounts, budget, actual, "AUD");

    const line = report.lines.find((l) => l.accountId === "exp-1");
    expect(line).toBeDefined();
    expect(line!.budgetAmount).toBe("0.0000");
    expect(line!.actualAmount).toBe("850.0000");
    expect(line!.unbudgetedActivity).toBe(true);
    expect(line!.variancePercent).toBeNull();
  });

  it("reconciles totals across a mix of matched, budget-only and actual-only accounts", () => {
    const budget = new Map([
      ["rev-1", "10000.0000"],
      ["exp-1", "2000.0000"],
    ]);
    const actual = new Map([
      ["rev-1", "11000.0000"],
      ["exp-2", "300.0000"],
    ]);
    const report = buildBudgetVarianceReport(accounts, budget, actual, "AUD");

    expect(report.lines).toHaveLength(3);
    expect(report.totalBudget).toBe("12000.0000");
    expect(report.totalActual).toBe("11300.0000");
    expect(report.totalVariance).toBe("-700.0000");
  });

  it("drops an account id with no matching account row rather than rendering a blank line", () => {
    const budget = new Map([["missing-account", "100.0000"]]);
    const report = buildBudgetVarianceReport(accounts, budget, new Map(), "AUD");
    expect(report.lines.some((l) => l.accountId === "missing-account")).toBe(false);
  });
});
