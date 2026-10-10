import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { PostingService } from "@/domain/ledger/posting-service";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { BudgetVarianceService } from "@/domain/budgeting/budget-variance-service";
import { ManagementPackService } from "@/domain/reporting/management-pack-service";
import { OverlappingActiveBaselineError } from "@/domain/budgeting/errors";

/**
 * Integration coverage for Phase 9 Slice 1 — budgets, Budget vs. Actual,
 * rolling forecast, and Management Pack wiring, all against the real test
 * database (never mocked), per docs/roadmap.md's standard for every slice.
 */
describe("Budgeting — Budget vs. Actual", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let org: Awaited<ReturnType<typeof createTestOrg>>;
  let bankAccountId: string;
  let revenueAccountId: string;
  let expenseAccountId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await createTestOrg("budgeting");
    const accountIds = await createSampleAccounts(org.owner, org.baseCurrency);
    bankAccountId = accountIds[0]!; // Business Bank Account
    revenueAccountId = accountIds[4]!; // Sales Revenue
    expenseAccountId = accountIds[5]!; // General Expenses
  });

  it("creates a budget, sets a whole account's monthly figures in one bulk call, and activates it", async () => {
    const budget = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      type: "BASELINE",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    expect(budget.status).toBe("DRAFT");

    const lines = await BudgetService.setAccountLines(org.owner, budget.id, {
      accountId: revenueAccountId,
      months: [
        { month: new Date("2026-01-01"), amount: "10000.00" },
        { month: new Date("2026-02-01"), amount: "11000.00" },
      ],
    });
    expect(lines).toHaveLength(2);

    const activated = await BudgetService.activate(org.owner, budget.id);
    expect(activated!.status).toBe("ACTIVE");
  });

  it("refuses to activate a second overlapping ACTIVE baseline budget", async () => {
    const first = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    await BudgetService.activate(org.owner, first.id);

    const second = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline #2",
      periodStart: new Date("2026-06-01"),
      periodEnd: new Date("2027-05-31"),
    });
    await expect(BudgetService.activate(org.owner, second.id)).rejects.toThrow(OverlappingActiveBaselineError);
  });

  it("allows a REVISED_FORECAST to coexist with an ACTIVE baseline covering the same period", async () => {
    const baseline = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    await BudgetService.activate(org.owner, baseline.id);

    const revised = await BudgetService.create(org.owner, {
      name: "FY2026 Revised",
      type: "REVISED_FORECAST",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    const activated = await BudgetService.activate(org.owner, revised.id);
    expect(activated!.status).toBe("ACTIVE");
  });

  it("reconciles Budget vs. Actual correctly, including the zero-budget and zero-actual edge cases", async () => {
    const budget = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });

    // Revenue: budgeted $10,000 for January, actual posted $12,000 (favorable variance).
    await BudgetService.setAccountLines(org.owner, budget.id, {
      accountId: revenueAccountId,
      months: [{ month: new Date("2026-01-01"), amount: "10000.00" }],
    });
    // Expense: budgeted $2,000 for January, NO actual posted at all (zero-actual edge case).
    await BudgetService.setAccountLines(org.owner, budget.id, {
      accountId: expenseAccountId,
      months: [{ month: new Date("2026-01-01"), amount: "2000.00" }],
    });

    // Post real, balanced activity: revenue $12,000 against a bank account. No activity at all is posted to expenseAccountId.
    await PostingService.postJournal(org.owner, {
      postingDate: new Date("2026-01-20"),
      lines: [
        { accountId: bankAccountId, debit: "12000.00", currency: org.baseCurrency },
        { accountId: revenueAccountId, credit: "12000.00", currency: org.baseCurrency },
      ],
    });

    const report = await BudgetVarianceService.getBudgetVsActual(org.owner, budget.id, {
      from: new Date("2026-01-01"),
      to: new Date("2026-01-31"),
    });

    const revenueLine = report.lines.find((l) => l.accountId === revenueAccountId);
    expect(revenueLine!.budgetAmount).toBe("10000.0000");
    expect(revenueLine!.actualAmount).toBe("12000.0000");
    expect(revenueLine!.variance).toBe("2000.0000");
    expect(revenueLine!.variancePercent).toBe("20.00");
    expect(revenueLine!.unbudgetedActivity).toBe(false);

    const expenseLine = report.lines.find((l) => l.accountId === expenseAccountId);
    expect(expenseLine!.budgetAmount).toBe("2000.0000");
    expect(expenseLine!.actualAmount).toBe("0.0000");
    expect(expenseLine!.variance).toBe("-2000.0000");
    expect(expenseLine!.unbudgetedActivity).toBe(false);
  });

  it("flags actual activity with no budget line, rather than dropping it", async () => {
    const budget = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    // No budget line for expenseAccountId at all.

    await PostingService.postJournal(org.owner, {
      postingDate: new Date("2026-03-10"),
      lines: [
        { accountId: expenseAccountId, debit: "450.00", currency: org.baseCurrency },
        { accountId: bankAccountId, credit: "450.00", currency: org.baseCurrency },
      ],
    });

    const report = await BudgetVarianceService.getBudgetVsActual(org.owner, budget.id, {
      from: new Date("2026-03-01"),
      to: new Date("2026-03-31"),
    });

    const line = report.lines.find((l) => l.accountId === expenseAccountId);
    expect(line).toBeDefined();
    expect(line!.budgetAmount).toBe("0.0000");
    expect(line!.actualAmount).toBe("450.0000");
    expect(line!.unbudgetedActivity).toBe(true);
  });

  it("creates a rolling forecast that carries forward unedited future periods while preserving past-period figures", async () => {
    const baseline = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    await BudgetService.setAccountLines(org.owner, baseline.id, {
      accountId: revenueAccountId,
      months: [
        { month: new Date("2026-01-01"), amount: "10000.00" },
        { month: new Date("2026-02-01"), amount: "10500.00" },
        { month: new Date("2026-03-01"), amount: "11000.00" },
      ],
    });

    const forecast = await BudgetService.createRollingForecast(org.owner, {
      sourceBudgetId: baseline.id,
      name: "FY2026 Rolling (from Feb)",
      carryForwardAfterDate: new Date("2026-01-31"),
    });
    expect(forecast.type).toBe("ROLLING_FORECAST");
    expect(forecast.status).toBe("DRAFT");

    const forecastLines = await BudgetService.getLines(org.owner, forecast.id);
    const jan = forecastLines.find((l) => l.periodStart.toISOString().startsWith("2026-01"));
    const feb = forecastLines.find((l) => l.periodStart.toISOString().startsWith("2026-02"));
    const mar = forecastLines.find((l) => l.periodStart.toISOString().startsWith("2026-03"));

    expect(jan!.amount).toBe("10000.0000"); // past period preserved exactly
    expect(feb!.amount).toBe("10500.0000"); // future period carried forward unedited
    expect(mar!.amount).toBe("11000.0000");

    // Editing the carried-forward future period on the new forecast doesn't touch the source baseline.
    await BudgetService.setAccountLines(org.owner, forecast.id, {
      accountId: revenueAccountId,
      months: [{ month: new Date("2026-02-01"), amount: "12000.00" }],
    });
    const sourceLinesAfterEdit = await BudgetService.getLines(org.owner, baseline.id);
    const sourceFeb = sourceLinesAfterEdit.find((l) => l.periodStart.toISOString().startsWith("2026-02"));
    expect(sourceFeb!.amount).toBe("10500.0000");
  });

  it("includes a correct Budget vs. Actual section in the Management Pack when an ACTIVE baseline exists, and omits it cleanly when none does", async () => {
    // No budget at all yet — the pack must omit the section without error.
    const packWithoutBudget = await ManagementPackService.generate(
      org.owner,
      { from: new Date("2026-01-01"), to: new Date("2026-01-31") },
      new Date("2026-01-31"),
    );
    expect(packWithoutBudget.budgetVsActual).toBeNull();

    const baseline = await BudgetService.create(org.owner, {
      name: "FY2026 Baseline",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    await BudgetService.setAccountLines(org.owner, baseline.id, {
      accountId: revenueAccountId,
      months: [{ month: new Date("2026-01-01"), amount: "5000.00" }],
    });
    await BudgetService.activate(org.owner, baseline.id);

    await PostingService.postJournal(org.owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankAccountId, debit: "5500.00", currency: org.baseCurrency },
        { accountId: revenueAccountId, credit: "5500.00", currency: org.baseCurrency },
      ],
    });

    const packWithBudget = await ManagementPackService.generate(
      org.owner,
      { from: new Date("2026-01-01"), to: new Date("2026-01-31") },
      new Date("2026-01-31"),
    );
    expect(packWithBudget.budgetVsActual).not.toBeNull();
    expect(packWithBudget.budgetVsActual!.budgetName).toBe("FY2026 Baseline");
    expect(packWithBudget.budgetVsActual!.totalBudget).toBe("5000.0000");
    expect(packWithBudget.budgetVsActual!.totalActual).toBe("5500.0000");
  });
});
