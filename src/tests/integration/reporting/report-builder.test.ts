import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { PostingService } from "@/domain/ledger/posting-service";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { ReportBuilderService, type ReportBuilderConfig } from "@/domain/reporting/report-builder-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * End-to-end coverage for Phase 5 Slice 2's report builder: that a config
 * produces mathematically correct numbers against real posted data, that a
 * saved report re-queries fresh data rather than ever caching a result
 * (the whole point of `saved_reports.config` existing — see
 * `src/db/schema.ts`'s doc comment), and that dimensional filtering
 * (master spec §4) actually restricts the underlying GL aggregation.
 */
describe("Report Builder (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let bankId: string;
  let revenueId: string;
  let expenseId: string;
  let currency: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("report-builder");
    owner = org.owner;
    currency = org.baseCurrency;
    const ids = await createSampleAccounts(owner, currency);
    bankId = ids[0]!;
    revenueId = ids[4]!;
    expenseId = ids[5]!;
  });

  const baseConfig = (): ReportBuilderConfig => ({
    rowGroupBy: "ACCOUNT_TYPE",
    accountTypes: ["REVENUE", "EXPENSE"],
    measure: "MOVEMENT",
    periodBreakdown: "NONE",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
  });

  it("MOVEMENT/ACCOUNT_TYPE matches hand-computed revenue and expense totals for the period", async () => {
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankId!, debit: "1000.00", currency },
        { accountId: revenueId!, credit: "1000.00", currency },
      ],
    });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-15"),
      lines: [
        { accountId: expenseId!, debit: "300.00", currency },
        { accountId: bankId!, credit: "300.00", currency },
      ],
    });

    const result = await ReportBuilderService.runConfig(owner, baseConfig());
    const revenueRow = result.rows.find((r) => r.key === "REVENUE");
    const expenseRow = result.rows.find((r) => r.key === "EXPENSE");
    expect(revenueRow?.values[0]).toBe("1000.0000");
    expect(expenseRow?.values[0]).toBe("300.0000");
    expect(result.grandTotals[0]).toBe("1300.0000");
  });

  it("MONTHLY breakdown produces one column per month with the right per-month totals", async () => {
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankId!, debit: "500.00", currency },
        { accountId: revenueId!, credit: "500.00", currency },
      ],
    });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-02-10"),
      lines: [
        { accountId: bankId!, debit: "700.00", currency },
        { accountId: revenueId!, credit: "700.00", currency },
      ],
    });

    const result = await ReportBuilderService.runConfig(owner, {
      ...baseConfig(),
      accountTypes: ["REVENUE"],
      dateFrom: "2026-01-01",
      dateTo: "2026-02-28",
      periodBreakdown: "MONTHLY",
    });

    expect(result.columns).toHaveLength(2);
    const revenueRow = result.rows.find((r) => r.key === "REVENUE");
    expect(revenueRow?.values).toEqual(["500.0000", "700.0000"]);
  });

  it("BALANCE measure reflects a cumulative as-of balance, not just the column's own period", async () => {
    await PostingService.postJournal(owner, {
      postingDate: new Date("2025-12-01"),
      lines: [
        { accountId: bankId!, debit: "5000.00", currency },
        { accountId: revenueId!, credit: "5000.00", currency }, // prior-period revenue, irrelevant here
      ],
    });

    const result = await ReportBuilderService.runConfig(owner, {
      rowGroupBy: "ACCOUNT",
      accountTypes: ["ASSET"],
      measure: "BALANCE",
      periodBreakdown: "NONE",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    const bankRow = result.rows.find((r) => r.key === bankId);
    // BALANCE is cumulative to the column's `to` date, so December's posting
    // still shows up even though the column's `dateFrom` is in January.
    expect(bankRow?.values[0]).toBe("5000.0000");
  });

  it("saving and reloading a report re-queries fresh data — it is never a cached snapshot", async () => {
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankId!, debit: "100.00", currency },
        { accountId: revenueId!, credit: "100.00", currency },
      ],
    });

    const saved = await ReportBuilderService.saveReport(owner, {
      name: "January revenue",
      visibility: "PERSONAL",
      config: { ...baseConfig(), accountTypes: ["REVENUE"] },
    });

    const firstRun = await ReportBuilderService.runSavedReport(owner, saved.id);
    expect(firstRun.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("100.0000");

    // Post a NEW transaction into the same period after saving the report.
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-20"),
      lines: [
        { accountId: bankId!, debit: "50.00", currency },
        { accountId: revenueId!, credit: "50.00", currency },
      ],
    });

    const secondRun = await ReportBuilderService.runSavedReport(owner, saved.id);
    expect(secondRun.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("150.0000");
  });

  it("an ORGANIZATION-visibility saved report is visible to a different member; a PERSONAL one is not", async () => {
    const accountant = await addTestMember(owner, "ACCOUNTANT");
    const personal = await ReportBuilderService.saveReport(owner, {
      name: "My personal view",
      visibility: "PERSONAL",
      config: baseConfig(),
    });
    const shared = await ReportBuilderService.saveReport(owner, {
      name: "Team view",
      visibility: "ORGANIZATION",
      config: baseConfig(),
    });

    const theirList = await ReportBuilderService.listSavedReports(accountant);
    expect(theirList.some((r) => r.id === shared.id)).toBe(true);
    expect(theirList.some((r) => r.id === personal.id)).toBe(false);
  });

  it("dimension filtering restricts the report to only journal lines tagged with that dimension value", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Project" });
    const projectA = await DimensionService.addValue(owner, dimension.id, { label: "Project A" });
    await DimensionService.addValue(owner, dimension.id, { label: "Project B" });

    // Tagged with Project A.
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankId!, debit: "400.00", currency },
        { accountId: revenueId!, credit: "400.00", currency, dimensionValueIds: [projectA.id] },
      ],
    });
    // Untagged revenue in the same period.
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-12"),
      lines: [
        { accountId: bankId!, debit: "900.00", currency },
        { accountId: revenueId!, credit: "900.00", currency },
      ],
    });

    const filtered = await ReportBuilderService.runConfig(owner, {
      ...baseConfig(),
      accountTypes: ["REVENUE"],
      dimensionValueId: projectA.id,
    });
    expect(filtered.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("400.0000");

    const unfiltered = await ReportBuilderService.runConfig(owner, { ...baseConfig(), accountTypes: ["REVENUE"] });
    expect(unfiltered.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("1300.0000");
  });

  it("ReportingService.getProfitAndLoss applies the same dimension filter as the report builder", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Location" });
    const sydney = await DimensionService.addValue(owner, dimension.id, { label: "Sydney" });

    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      lines: [
        { accountId: bankId!, debit: "250.00", currency },
        { accountId: revenueId!, credit: "250.00", currency, dimensionValueIds: [sydney.id] },
      ],
    });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-11"),
      lines: [
        { accountId: bankId!, debit: "750.00", currency },
        { accountId: revenueId!, credit: "750.00", currency },
      ],
    });

    const filtered = await ReportingService.getProfitAndLoss(
      owner,
      { from: new Date("2026-01-01"), to: new Date("2026-01-31") },
      undefined,
      sydney.id,
    );
    expect(filtered.totalRevenue).toBe("250.0000");

    const unfiltered = await ReportingService.getProfitAndLoss(owner, {
      from: new Date("2026-01-01"),
      to: new Date("2026-01-31"),
    });
    expect(unfiltered.totalRevenue).toBe("1000.0000");
  });
});
