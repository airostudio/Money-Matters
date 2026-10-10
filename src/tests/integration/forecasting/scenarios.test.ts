import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedForecastData, type ForecastSeed } from "../../helpers/forecast-fixtures";
import { auditLogs } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import { InvalidScenarioError, ScenarioBaselineUnavailableError, ScenarioNotFoundError } from "@/domain/forecasting/errors";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { InvoiceService } from "@/domain/sales/invoice-service";

const ASOF = D("2026-10-05");
const OPTS = { asOfDate: ASOF };

/**
 * Baseline hand-calculation for the seed (see `seedForecastData`), asOf 2026-10-05, trailing 3 full months
 * (Jul–Sep 2026): revenue 1,000 + 2,700 + 4,500 = 8,200 → 2,733.3333/month; expenses 10,500 → 3,500/month;
 * baseline net −766.6667/month. Opening cash 10,000 → baseline 12-month end cash = 800.0000.
 * Trailing-12-month invoiced revenue: Acme 7,000 + Fresh Co 2,200 = 9,200 (= P&L revenue, so scope shares are exact).
 */
describe("Scenario modelling (Phase 9 Slice 2) — seeded realistic data, hand-verified", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let seed: ForecastSeed;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("scenarios");
    owner = org.owner;
    currency = org.baseCurrency;
    seed = await seedForecastData(owner, currency);
  });

  async function saveHire(overrides: Record<string, unknown> = {}) {
    return ScenarioService.create(owner, {
      name: "Hire a salesperson",
      type: "HIRE_EMPLOYEE",
      parameters: { annualSalary: "90000", onCostPercent: "12", startDate: "2026-11-01", ...overrides },
    });
  }

  it("baseline: trailing-3-month actuals, held flat, with opening cash from the same cash position the forecast uses", async () => {
    const scenario = await saveHire();
    const r = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(r.baseline.openingCash).toBe("10000.0000");
    expect(r.baseline.months).toHaveLength(12);
    expect(r.baseline.months[0]).toEqual({ month: "2026-11", revenue: "2733.3333", expenses: "3500.0000" });
    expect(r.baseline.months[11]!.month).toBe("2027-10");
    expect(r.cases.EXPECTED.summary.baselineEndCash).toBe("800.0000");
    expect(r.cases.EXPECTED.summary.baselineRunwayMonths).toBeNull();
  });

  it("HIRE_EMPLOYEE: Best / Expected / Worst against the baseline (hand-computed)", async () => {
    const scenario = await saveHire({ incrementalMonthlyRevenue: "6000", rampMonths: 3 });
    const r = await ScenarioService.run(owner, scenario.id, OPTS);

    // Fully loaded cost 90,000/12 × 1.12 = 8,400/month. Revenue ramps 1/3, 2/3, full of 6,000: 2,000, 4,000, then 6,000.
    expect(r.keyFigures[0]!.value).toContain("8400.0000");

    // EXPECTED: revenue 2,000 + 4,000 + 10 × 6,000 = 66,000; cost 12 × 8,400 = 100,800; net −34,800. End cash 800 − 34,800 = −34,000.
    const e = r.cases.EXPECTED;
    expect(e.summary.twelveMonthRevenueDelta).toBe("66000.0000");
    expect(e.summary.twelveMonthExpenseDelta).toBe("100800.0000");
    expect(e.summary.twelveMonthNetProfitDelta).toBe("-34800.0000");
    expect(e.summary.scenarioEndCash).toBe("-34000.0000");
    expect(e.months[0]!.netProfitDelta).toBe("-6400.0000"); // Nov: +2,000 − 8,400
    expect(e.summary.breakEven).toMatchObject({ status: "NOT_WITHIN_12_MONTHS" } as object);

    // BEST (125% productivity): revenue 66,000 × 1.25 = 82,500; net −18,300.
    expect(r.cases.BEST.summary.twelveMonthRevenueDelta).toBe("82500.0000");
    expect(r.cases.BEST.summary.twelveMonthNetProfitDelta).toBe("-18300.0000");

    // WORST (0%): pure cost, −100,800; cash runs out almost at once (baseline never does within 12 months).
    const w = r.cases.WORST;
    expect(w.summary.twelveMonthNetProfitDelta).toBe("-100800.0000");
    expect(w.summary.scenarioEndCash).toBe("-100000.0000");
    expect(w.summary.baselineRunwayMonths).toBeNull();
    expect(w.summary.scenarioRunwayMonths).toBe("1.1"); // Nov end 833.3333, Dec end −8,333.3333 → 1 + 833.3333/9,166.6667

    // Every case discloses its assumptions, and they differ only where the user's spreads say so.
    expect(e.assumptions.find((a) => a.label.startsWith("Revenue realised"))!.value).toBe("100%");
    expect(r.cases.BEST.assumptions.find((a) => a.label.startsWith("Revenue realised"))!.value).toBe("125%");
    expect(w.assumptions.find((a) => a.label.startsWith("Revenue realised"))!.value).toBe("0%");
    expect(r.caveats.join(" ")).toMatch(/not predictions/);
  });

  it("PRICE_CHANGE (+10%, all customers): no volume loss expected; the explicit volume assumption drives worst case", async () => {
    const scenario = await ScenarioService.create(owner, {
      name: "Price rise",
      type: "PRICE_CHANGE",
      parameters: { priceChangePercent: "10", effectiveDate: "2026-11-01" },
    });
    const r = await ScenarioService.run(owner, scenario.id, OPTS);

    expect(r.derivedInputs.find((d) => d.label.startsWith("Share"))!.value).toBe("100.00%");
    // EXPECTED: 10% × 2,733.3333 × 12 = 3,280 revenue, all profit.
    expect(r.cases.EXPECTED.summary.twelveMonthNetProfitDelta).toBe("3280.0000");
    expect(r.cases.BEST.summary.twelveMonthNetProfitDelta).toBe("3280.0000"); // no case assumes a volume gain
    // WORST (documented default −5% volume): (1.10)(0.95) − 1 = 4.5% → 1,476; no tracked-inventory cost to avoid.
    expect(r.cases.WORST.summary.twelveMonthNetProfitDelta).toBe("1476.0000");
    expect(r.cases.WORST.assumptions.find((a) => a.label === "Volume change assumed")!.value).toBe("-5%");
    expect(r.derivedInputs.find((d) => d.label.startsWith("Variable"))!.note).toMatch(/0 means none is attributable/);
  });

  it("PRICE_CHANGE scoped to one customer applies only to that customer's share of revenue (7,000 of 9,200)", async () => {
    const scenario = await ScenarioService.create(owner, {
      name: "Price rise — Acme only",
      type: "PRICE_CHANGE",
      parameters: { priceChangePercent: "10", effectiveDate: "2026-11-01", scope: { kind: "CUSTOMERS", customerContactIds: [seed.acme] } },
    });
    const r = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(r.derivedInputs.find((d) => d.label.startsWith("In-scope revenue"))!.value).toContain("7000.0000");
    // 32,800 × (7,000/9,200) × 10% = 2,495.6522
    expect(r.cases.EXPECTED.summary.twelveMonthNetProfitDelta).toBe("2495.6522");
  });

  it("LOSE_CUSTOMER defaults to the largest customer by trailing-12-month revenue, and models revenue, cash and the worst-case collection delay", async () => {
    const scenario = await ScenarioService.create(owner, {
      name: "Lose largest customer",
      type: "LOSE_CUSTOMER",
      parameters: { effectiveDate: "2026-11-01" },
    });
    const r = await ScenarioService.run(owner, scenario.id, OPTS);

    expect(r.derivedInputs[0]).toMatchObject({ label: "Customer", value: "Acme Pty Ltd" });
    expect(r.derivedInputs.find((d) => d.label.startsWith("Trailing-12-month revenue"))!.value).toContain("7000.0000");
    expect(r.derivedInputs.find((d) => d.label.startsWith("Open receivables"))!.value).toContain("5000.0000"); // invoices C + D
    // No tracked-inventory cost → revenue-only, and the result says so.
    expect(r.derivedInputs.find((d) => d.label.startsWith("Cost avoided"))!.note).toMatch(/REVENUE-ONLY/);

    // Share 7,000/9,200 of the 2,733.3333 baseline = 2,079.7101/month lost from November (all 12 months).
    const e = r.cases.EXPECTED;
    expect(e.summary.twelveMonthRevenueDelta).toBe("-24956.5217");
    expect(e.summary.twelveMonthNetProfitDelta).toBe("-24956.5217"); // no avoided cost entered
    expect(e.summary.scenarioEndCash).toBe("-24156.5217"); // 800 − 24,956.5217

    // BEST: half the lost revenue replaced from February (effective month + 3): 24,956.5217 − 9 × 1,039.8551 = 15,597.8261 lost.
    expect(r.cases.BEST.summary.twelveMonthNetProfitDelta).toBe("-15597.8261");

    // WORST: same P&L as expected, plus Acme's 5,000 open receivables arriving 2 months late — a pure timing shift.
    const w = r.cases.WORST;
    expect(w.summary.twelveMonthNetProfitDelta).toBe("-24956.5217");
    expect(w.months[0]!.cashTimingAdjustment).toBe("-5000.0000"); // Nov
    expect(w.months[2]!.cashTimingAdjustment).toBe("5000.0000"); // Jan
    expect(w.summary.scenarioEndCash).toBe(e.summary.scenarioEndCash);
    // …but the dip is deeper mid-window, which is the point of the worst case.
    expect(Number(w.months[1]!.scenarioCash)).toBeLessThan(Number(e.months[1]!.scenarioCash));
  });

  it("LOSE_CUSTOMER with an explicit customer and an avoided-cost override", async () => {
    const scenario = await ScenarioService.create(owner, {
      name: "Lose Fresh Co",
      type: "LOSE_CUSTOMER",
      parameters: { customerContactId: seed.fresh, effectiveDate: "2026-11-01", avoidedCostPercentOverride: "50" },
    });
    const r = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(r.derivedInputs[0]!.value).toBe("Fresh Co");
    // Fresh Co share 2,200/9,200 → revenue lost 32,800 × 2,200/9,200 = 7,843.4783; half of it is avoided cost.
    expect(r.cases.EXPECTED.summary.twelveMonthRevenueDelta).toBe("-7843.4783");
    expect(r.cases.EXPECTED.summary.twelveMonthExpenseDelta).toBe("-3921.7391");
    expect(r.cases.EXPECTED.summary.twelveMonthNetProfitDelta).toBe("-3921.7391");
  });

  it("a BUDGET baseline reads the ACTIVE baseline budget; with none it fails loudly instead of inventing a baseline", async () => {
    const scenario = await saveHire({ baseline: { source: "BUDGET" } });
    await expect(ScenarioService.run(owner, scenario.id, OPTS)).rejects.toThrow(ScenarioBaselineUnavailableError);

    const budget = await BudgetService.create(owner, {
      name: "FY27 baseline",
      periodStart: D("2026-11-01"),
      periodEnd: D("2027-10-31"),
    });
    const months = Array.from({ length: 12 }, (_, i) => ({ month: new Date(Date.UTC(2026, 10 + i, 1)), amount: "" }));
    await BudgetService.setAccountLines(owner, budget.id, { accountId: seed.revenueAccountId, months: months.map((m) => ({ ...m, amount: "5000.00" })) });
    await BudgetService.setAccountLines(owner, budget.id, { accountId: seed.expenseAccountId, months: months.map((m) => ({ ...m, amount: "2000.00" })) });
    await BudgetService.activate(owner, budget.id);

    const r = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(r.baseline.source).toBe("BUDGET");
    expect(r.baseline.label).toContain("FY27 baseline");
    expect(r.baseline.months[0]).toEqual({ month: "2026-11", revenue: "5000.0000", expenses: "2000.0000" });
    // Baseline net +3,000/month → 10,000 + 36,000 = 46,000; expected hire (pure cost) −100,800 → −54,800.
    expect(r.cases.EXPECTED.summary.baselineEndCash).toBe("46000.0000");
    expect(r.cases.EXPECTED.summary.scenarioEndCash).toBe("-54800.0000");
    expect(r.baseline.warnings).toEqual([]);
  });

  it("freshness: a saved scenario is a saved QUERY — re-running after new postings reflects them (no stored result)", async () => {
    const scenario = await saveHire();
    const before = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(before.baseline.months[0]!.revenue).toBe("2733.3333");

    // A new 3,000 invoice issued in September lifts trailing-3-month revenue to 11,200 → 3,733.3333/month.
    const created = await InvoiceService.create(owner, {
      customerContactId: seed.fresh,
      issueDate: D("2026-09-25"),
      dueDate: D("2026-10-25"),
      currency,
      arAccountId: seed.sales.arAccountId,
      lines: [{ description: "Late September work", quantity: "1", unitPrice: "3000.00", accountId: seed.revenueAccountId }],
    });
    await InvoiceService.approveAndPost(owner, created.id);

    const after = await ScenarioService.run(owner, scenario.id, OPTS);
    expect(after.baseline.months[0]!.revenue).toBe("3733.3333");
    expect(after.cases.EXPECTED.summary.baselineEndCash).not.toBe(before.cases.EXPECTED.summary.baselineEndCash);
    // The stored row is just parameters — nothing computed was ever persisted.
    const stored = await ScenarioService.get(owner, scenario.id);
    expect(JSON.stringify(stored!.parameters)).not.toMatch(/EndCash|months|summary/);
  });

  it("includes the 90-day cash forecast as context beside the 12-month comparison", async () => {
    const r = await ScenarioService.run(owner, (await saveHire()).id, OPTS);
    expect(r.forecastContext).not.toBeNull();
    expect(r.forecastContext!.knownOnlyLowPoint).toEqual({ date: "2026-10-15", balance: "2500.0000" });
    expect(r.forecastContext!.payrollOmitted).toBe(false);
    const noContext = await ScenarioService.run(owner, (await saveHire()).id, { ...OPTS, includeForecastContext: false });
    expect(noContext.forecastContext).toBeNull();
  });

  it("preview runs unsaved parameters through the same validation and maths, persisting nothing", async () => {
    const r = await ScenarioService.preview(owner, "HIRE_EMPLOYEE", { annualSalary: "90000", onCostPercent: "12", startDate: "2026-11-01" }, OPTS);
    expect(r.scenarioId).toBeNull();
    expect(r.cases.WORST.summary.twelveMonthNetProfitDelta).toBe("-100800.0000");
    expect(await ScenarioService.list(owner)).toHaveLength(0);
    await expect(ScenarioService.preview(owner, "HIRE_EMPLOYEE", { annualSalary: "x" }, OPTS)).rejects.toThrow(InvalidScenarioError);
  });

  it("scenarios are analysis only: running them never changes the ledger", async () => {
    const before = await LedgerService.getTrialBalance(owner, new Date("2027-12-31"));
    for (const [type, parameters] of [
      ["HIRE_EMPLOYEE", { annualSalary: "90000", onCostPercent: "12", startDate: "2026-11-01" }],
      ["PRICE_CHANGE", { priceChangePercent: "10", effectiveDate: "2026-11-01" }],
      ["LOSE_CUSTOMER", { effectiveDate: "2026-11-01" }],
    ] as const) {
      const s = await ScenarioService.create(owner, { name: type, type, parameters });
      await ScenarioService.run(owner, s.id, OPTS);
    }
    expect(await LedgerService.getTrialBalance(owner, new Date("2027-12-31"))).toEqual(before);
  });

  it("rejects malformed or missing parameters on create and update, and a nameless scenario", async () => {
    await expect(ScenarioService.create(owner, { name: "x", type: "HIRE_EMPLOYEE", parameters: { onCostPercent: "12", startDate: "2026-11-01" } })).rejects.toThrow(InvalidScenarioError);
    await expect(ScenarioService.create(owner, { name: "x", type: "PRICE_CHANGE", parameters: { priceChangePercent: "0", effectiveDate: "2026-11-01" } })).rejects.toThrow(InvalidScenarioError);
    await expect(ScenarioService.create(owner, { name: "  ", type: "LOSE_CUSTOMER", parameters: { effectiveDate: "2026-11-01" } })).rejects.toThrow(/name/);
    const s = await saveHire();
    await expect(ScenarioService.update(owner, s.id, { parameters: { annualSalary: "-1", onCostPercent: "12", startDate: "2026-11-01" } })).rejects.toThrow(InvalidScenarioError);
  });

  it("every mutation is audited: create, update, delete", async () => {
    const s = await saveHire();
    await ScenarioService.update(owner, s.id, { name: "Renamed" });
    await ScenarioService.delete(owner, s.id);
    const rows = await withTenant(owner.organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.entityType, "Scenario")));
    expect(rows.map((r) => r.action).sort()).toEqual(["scenario.created", "scenario.deleted", "scenario.updated"]);
    await expect(ScenarioService.run(owner, s.id, OPTS)).rejects.toThrow(ScenarioNotFoundError);
  });

  it("permissions: a read-only role can view and run scenarios but not create or delete them; a role without finance access can do neither", async () => {
    const s = await saveHire();
    const manager = actorWithRole(owner, "MANAGER");
    await expect(ScenarioService.list(manager)).resolves.toHaveLength(1);
    await expect(ScenarioService.run(manager, s.id, OPTS)).resolves.toBeDefined();
    await expect(ScenarioService.create(manager, { name: "n", type: "LOSE_CUSTOMER", parameters: { effectiveDate: "2026-11-01" } })).rejects.toThrow(PermissionDeniedError);
    await expect(ScenarioService.delete(manager, s.id)).rejects.toThrow(PermissionDeniedError);

    const employee = actorWithRole(owner, "EMPLOYEE");
    await expect(ScenarioService.list(employee)).rejects.toThrow(PermissionDeniedError);
    await expect(ScenarioService.run(employee, s.id, OPTS)).rejects.toThrow(PermissionDeniedError);
  });

  it("the suggested hire on-cost comes from Phase 8's verified SG rule (a suggestion, never applied silently)", async () => {
    const suggestion = await ScenarioService.suggestedHireOnCost(ASOF);
    expect(suggestion!.percent).toBe("12.00");
    expect(suggestion!.source).toMatch(/FY2026-27/);
    // Outside any seeded rule set → null, never extrapolated.
    expect(await ScenarioService.suggestedHireOnCost(D("2040-01-01"))).toBeNull();
    // And the on-cost is still a required parameter — nothing defaults it.
    await expect(ScenarioService.create(owner, { name: "x", type: "HIRE_EMPLOYEE", parameters: { annualSalary: "90000", startDate: "2026-11-01" } })).rejects.toThrow(InvalidScenarioError);
  });

  it("lists customers by trailing-12-month revenue, largest first", async () => {
    const rows = await ScenarioService.listCustomerRevenue(owner, ASOF);
    expect(rows.map((r) => r.name)).toEqual(["Acme Pty Ltd", "Fresh Co"]);
    expect(rows[0]!.revenue).toBe("7000.0000");
  });
});
