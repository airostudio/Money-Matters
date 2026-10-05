import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import {
  activeFraction,
  assembleCase,
  clampedShare,
  computeBreakEven,
  hireDeltas,
  hireMonthlyCost,
  loseCustomerDeltas,
  priceChangeDeltas,
  priceRevenueFactor,
  projectionMonths,
  runwayMonths,
  type BaselineMonth,
  type CaseName,
} from "@/domain/forecasting/scenario-calculations";
import {
  HireEmployeeParamsSchema,
  LoseCustomerParamsSchema,
  PriceChangeParamsSchema,
} from "@/domain/forecasting/scenario-parameters";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const AUD = "AUD";
const ASOF = D("2026-10-05");
const MONTHS = projectionMonths(ASOF); // Nov 2026 .. Oct 2027

function baseline(revenue = "50000", expenses = "40000"): BaselineMonth[] {
  return MONTHS.map((monthStart) => ({ monthStart, revenue: Money.of(revenue, AUD), expenses: Money.of(expenses, AUD) }));
}
const OPENING = Money.of("100000", AUD);

describe("calendar helpers", () => {
  it("projects the next 12 FULL calendar months after the as-of month", () => {
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[0]!.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(MONTHS[11]!.toISOString().slice(0, 10)).toBe("2027-10-01");
    // December as-of rolls the year.
    expect(projectionMonths(D("2026-12-20"))[0]!.toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("activeFraction: whole month before/at start, none after, pro-rata inside", () => {
    expect(activeFraction(D("2026-11-01"), D("2026-10-20")).toString()).toBe("1");
    expect(activeFraction(D("2026-11-01"), D("2026-11-01")).toString()).toBe("1");
    expect(activeFraction(D("2026-11-01"), D("2026-12-01")).toString()).toBe("0");
    // 16 Nov: 15 of 30 days remain (16th inclusive).
    expect(activeFraction(D("2026-11-01"), D("2026-11-16")).toString()).toBe("0.5");
  });
});

describe("HIRE_EMPLOYEE — hand-computed", () => {
  const params = HireEmployeeParamsSchema.parse({
    annualSalary: "120000",
    onCostPercent: "12",
    startDate: "2026-11-16",
    incrementalMonthlyRevenue: "20000",
    rampMonths: 4,
  });

  it("fully loaded monthly cost = salary/12 × (1 + on-cost%) = 10,000 × 1.12 = 11,200", () => {
    expect(hireMonthlyCost(params, AUD).toString()).toBe("11200.0000");
  });

  const run = (c: CaseName) => assembleCase(c, [], baseline(), hireDeltas(params, c, MONTHS, AUD), OPENING);

  it("EXPECTED: pro-rated first month, revenue ramping 25/50/75/100% over 4 months", () => {
    const r = run("EXPECTED");
    const m = r.months;
    // Nov: cost 11,200 × 0.5 = 5,600; revenue 20,000 × (1/4 ramp) × 0.5 = 2,500 → net delta −3,100.
    expect(m[0]!.scenarioExpenses).toBe("45600.0000");
    expect(m[0]!.scenarioRevenue).toBe("52500.0000");
    expect(m[0]!.netProfitDelta).toBe("-3100.0000");
    // Dec: +10,000 revenue (50%), +11,200 cost → −1,200. Jan: +15,000 − 11,200 = +3,800. Feb on: +20,000 − 11,200 = +8,800.
    expect(m[1]!.netProfitDelta).toBe("-1200.0000");
    expect(m[2]!.netProfitDelta).toBe("3800.0000");
    expect(m[3]!.netProfitDelta).toBe("8800.0000");
    // 12-month totals: revenue 2,500 + 10,000 + 15,000 + 9 × 20,000 = 207,500; expense 5,600 + 11 × 11,200 = 128,800.
    expect(r.summary.twelveMonthRevenueDelta).toBe("207500.0000");
    expect(r.summary.twelveMonthExpenseDelta).toBe("128800.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("78700.0000");
    // Cash: baseline 100,000 + 12 × 10,000 = 220,000; scenario +78,700.
    expect(r.summary.baselineEndCash).toBe("220000.0000");
    expect(r.summary.scenarioEndCash).toBe("298700.0000");
    // Break-even: monthly impact first non-negative in Jan 2027; cumulative (−3,100, −4,300, −500, +8,300) back ≥ 0 in Feb 2027.
    expect(r.summary.breakEven).toEqual({ status: "REACHED", monthlyBreakEvenMonth: "2027-01", cumulativePaybackMonth: "2027-02" });
  });

  it("BEST (125% productivity): November revenue is 20,000 × 1.25 × 0.25 × 0.5 = 3,125", () => {
    const r = run("BEST");
    expect(r.months[0]!.scenarioRevenue).toBe("53125.0000");
    // 12-month revenue 207,500 × 1.25 = 259,375.
    expect(r.summary.twelveMonthRevenueDelta).toBe("259375.0000");
  });

  it("WORST (0% productivity): pure cost — never breaks even, cash still above zero but lower than baseline", () => {
    const r = run("WORST");
    expect(r.summary.twelveMonthRevenueDelta).toBe("0.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("-128800.0000");
    expect(r.summary.scenarioEndCash).toBe("91200.0000");
    expect(r.summary.lowestScenarioCash).toEqual({ month: "2027-10", balance: "91200.0000" });
    expect(r.summary.breakEven.status).toBe("NOT_WITHIN_12_MONTHS");
    expect(r.summary.scenarioRunwayMonths).toBeNull(); // does not run out within the 12 modelled months
  });

  it("a hire who started before the window is fully active (and fully ramped) from month 1", () => {
    const early = HireEmployeeParamsSchema.parse({ annualSalary: "120000", onCostPercent: "12", startDate: "2026-01-05", incrementalMonthlyRevenue: "20000", rampMonths: 4 });
    const m = assembleCase("EXPECTED", [], baseline(), hireDeltas(early, "EXPECTED", MONTHS, AUD), OPENING).months;
    expect(m[0]!.netProfitDelta).toBe("8800.0000");
  });
});

describe("PRICE_CHANGE — hand-computed", () => {
  const params = PriceChangeParamsSchema.parse({ priceChangePercent: "8", effectiveDate: "2026-11-01" });
  const share = new Decimal("0.4"); // in-scope revenue is 40% of the 50,000 baseline = 20,000
  const run = (c: CaseName, p = params) => assembleCase(c, [], baseline(), priceChangeDeltas(p, c, baseline(), share, "30", AUD), OPENING);

  it("price factor compounds with volume: (1.08)(0.95) − 1 = 0.026", () => {
    expect(priceRevenueFactor("8", "-5").toString()).toBe("0.026");
    expect(priceRevenueFactor("8", "0").toString()).toBe("0.08");
  });

  it("EXPECTED (no volume loss): +8% on 20,000 = +1,600 revenue every month, all of it profit", () => {
    const r = run("EXPECTED");
    expect(r.months[0]!.netProfitDelta).toBe("1600.0000");
    expect(r.summary.twelveMonthRevenueDelta).toBe("19200.0000");
    expect(r.summary.twelveMonthExpenseDelta).toBe("0.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("19200.0000");
    expect(r.summary.breakEven.status).toBe("NOT_NEEDED");
  });

  it("WORST (5% volume lost): revenue +520, but 5% of 20,000 × 30% = 300 of cost avoided → net +820 per month", () => {
    const r = run("WORST");
    expect(r.months[0]!.scenarioRevenue).toBe("50520.0000");
    expect(r.months[0]!.scenarioExpenses).toBe("39700.0000");
    expect(r.months[0]!.netProfitDelta).toBe("820.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("9840.0000");
  });

  it("a mid-month effective date pro-rates the first month: 16 Nov → half of 1,600", () => {
    const mid = PriceChangeParamsSchema.parse({ priceChangePercent: "8", effectiveDate: "2026-11-16" });
    const r = run("EXPECTED", mid);
    expect(r.months[0]!.netProfitDelta).toBe("800.0000");
    expect(r.months[1]!.netProfitDelta).toBe("1600.0000");
  });

  it("a price DECREASE with the same volume reduces revenue", () => {
    const cut = PriceChangeParamsSchema.parse({ priceChangePercent: "-10", effectiveDate: "2026-11-01" });
    expect(run("EXPECTED", cut).months[0]!.netProfitDelta).toBe("-2000.0000");
  });

  it("scope share is clamped to [0, 1] and is 0 with no revenue", () => {
    expect(clampedShare(Money.of("30", AUD), Money.of("100", AUD)).toString()).toBe("0.3");
    expect(clampedShare(Money.of("300", AUD), Money.of("100", AUD)).toString()).toBe("1");
    expect(clampedShare(Money.of("30", AUD), Money.zero(AUD)).toString()).toBe("0");
  });
});

describe("LOSE_CUSTOMER — hand-computed", () => {
  // Customer = 30% of the 50,000 baseline revenue = 15,000/month; 20% of that revenue is avoided cost.
  const params = LoseCustomerParamsSchema.parse({ effectiveDate: "2026-12-01" });
  const share = new Decimal("0.3");
  const OPEN_AR = Money.of("9000", AUD);
  const run = (c: CaseName) => assembleCase(c, [], baseline(), loseCustomerDeltas(params, c, baseline(), share, "20", OPEN_AR, AUD), OPENING);

  it("EXPECTED: full loss from December — −15,000 revenue, +3,000 avoided cost → −12,000 profit/month for 11 months", () => {
    const r = run("EXPECTED");
    expect(r.months[0]!.netProfitDelta).toBe("0.0000"); // November: not yet lost
    expect(r.months[1]!.scenarioRevenue).toBe("35000.0000");
    expect(r.months[1]!.scenarioExpenses).toBe("37000.0000");
    expect(r.months[1]!.netProfitDelta).toBe("-12000.0000");
    expect(r.summary.twelveMonthRevenueDelta).toBe("-165000.0000");
    expect(r.summary.twelveMonthExpenseDelta).toBe("-33000.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("-132000.0000");
    expect(r.summary.scenarioEndCash).toBe("88000.0000"); // 220,000 − 132,000
  });

  it("BEST: 50% of the lost revenue replaced from March (3 months after December) → lost revenue 105,000, net −84,000", () => {
    const r = run("BEST");
    expect(r.months[1]!.netProfitDelta).toBe("-12000.0000"); // Dec
    expect(r.months[3]!.netProfitDelta).toBe("-12000.0000"); // Feb, still before replacement
    expect(r.months[4]!.netProfitDelta).toBe("-6000.0000"); // Mar: replaced 50%
    expect(r.summary.twelveMonthRevenueDelta).toBe("-105000.0000");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("-84000.0000");
  });

  it("WORST: same P&L as EXPECTED, plus the customer's 9,000 open receivables collected 2 months late — a pure cash-timing shift", () => {
    const r = run("WORST");
    expect(r.summary.twelveMonthNetProfitDelta).toBe("-132000.0000");
    expect(r.months[1]!.cashTimingAdjustment).toBe("-9000.0000"); // Dec: not collected
    expect(r.months[3]!.cashTimingAdjustment).toBe("9000.0000"); // Feb: collected two months late
    // Cash: Nov 110,000; Dec 110,000 − 2,000 − 9,000 = 99,000; Jan 97,000; Feb 97,000 − 2,000 + 9,000 = 104,000.
    expect(r.months[1]!.scenarioCash).toBe("99000.0000");
    expect(r.months[2]!.scenarioCash).toBe("97000.0000");
    expect(r.months[3]!.scenarioCash).toBe("104000.0000");
    // The timing shift nets to zero over the window.
    expect(r.summary.scenarioEndCash).toBe("88000.0000");
  });

  it("with no avoided cost entered (revenue-only view), the profit hit equals the full revenue loss", () => {
    const noCost = assembleCase("EXPECTED", [], baseline(), loseCustomerDeltas(params, "EXPECTED", baseline(), share, "0", OPEN_AR, AUD), OPENING);
    expect(noCost.months[1]!.netProfitDelta).toBe("-15000.0000");
  });
});

describe("runway and break-even", () => {
  it("runway interpolates inside the month cash crosses zero; null when it never does", () => {
    // 100,000 opening burning 40,000/month: 60,000 / 20,000 / −20,000 → crosses in month 3 (index 2): 2 + 20,000/40,000 = 2.5.
    const end = [Money.of("60000", AUD), Money.of("20000", AUD), Money.of("-20000", AUD), Money.of("-60000", AUD)];
    expect(runwayMonths(OPENING, end)).toBe("2.5");
    expect(runwayMonths(OPENING, [Money.of("1", AUD), Money.of("2", AUD)])).toBeNull();
    expect(runwayMonths(Money.of("-1", AUD), [Money.of("-2", AUD)])).toBe("0.0");
  });

  it("break-even: NOT_NEEDED when the impact is never negative", () => {
    expect(computeBreakEven([Money.of("0", AUD), Money.of("10", AUD)], ["a", "b"]).status).toBe("NOT_NEEDED");
  });

  it("break-even: NOT_WITHIN_12_MONTHS when it never turns non-negative", () => {
    expect(computeBreakEven([Money.of("-1", AUD), Money.of("-1", AUD)], ["a", "b"])).toEqual({
      status: "NOT_WITHIN_12_MONTHS",
      monthlyBreakEvenMonth: null,
      cumulativePaybackMonth: null,
    });
  });

  it("a baseline already burning cash shows a shorter runway in the scenario than the baseline", () => {
    // Baseline loses 10,000/month (revenue 30,000, expenses 40,000), opening 100,000; losing a 20%-of-revenue customer makes it worse.
    const base = baseline("30000", "40000");
    const lose = LoseCustomerParamsSchema.parse({ effectiveDate: "2026-11-01" });
    const r = assembleCase("EXPECTED", [], base, loseCustomerDeltas(lose, "EXPECTED", base, new Decimal("0.2"), "0", Money.zero(AUD), AUD), OPENING);
    // Baseline: 100,000 − 10,000/month → zero after exactly 10 months (does not go below zero within 12? it does at month 11).
    expect(r.summary.baselineRunwayMonths).toBe("10.0");
    // Scenario: −16,000/month → crosses during month 7 (index 6): 6 + 4,000/16,000 = 6.25, shown to 1 dp using the ledger's
    // banker's rounding (half-even) → "6.2".
    expect(r.summary.scenarioRunwayMonths).toBe("6.2");
  });
});
