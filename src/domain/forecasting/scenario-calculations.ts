import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import { dateKey } from "./forecast-calculations";
import type { HireEmployeeParams, LoseCustomerParams, PriceChangeParams } from "./scenario-parameters";

/**
 * Pure, DB-free scenario maths (master spec §37) — every function is
 * exercised against hand-computed inputs in
 * `src/tests/unit/forecasting/scenario-calculations.test.ts`.
 *
 * **What this is.** A transparent, month-by-month what-if over a 12-month
 * window: the next 12 full calendar months after today. The "unmodified
 * baseline" is a flat (trailing-actuals) or budgeted monthly P&L; each
 * scenario type adds explicit monthly revenue/expense DELTAS to it; cash is a
 * run-rate path (opening cash + cumulative monthly net profit) — NOT a
 * working-capital model — so a scenario's cash effect is its P&L effect plus
 * (for LOSE_CUSTOMER's worst case) one explicit receivables-timing shift.
 *
 * **What it is not.** The three cases (Best / Expected / Worst) differ ONLY by
 * explicit, user-editable assumptions visible in every case's
 * `assumptions` list — they are modelling assumptions, never predictions, and
 * the UI says so.
 */

export type CaseName = "BEST" | "EXPECTED" | "WORST";
export const CASE_NAMES: CaseName[] = ["BEST", "EXPECTED", "WORST"];

export const PROJECTION_MONTHS = 12;

export interface BaselineMonth {
  /** First day of the calendar month (UTC). */
  monthStart: Date;
  revenue: Money;
  expenses: Money;
}

export interface MonthlyDelta {
  revenueDelta: Money;
  /** Positive = more expense. */
  expenseDelta: Money;
  /** Pure cash-timing shift with no P&L effect (LOSE_CUSTOMER worst case). */
  cashTimingAdjustment: Money;
}

export interface CaseAssumption {
  label: string;
  value: string;
  /** Which saved parameter this comes from, so the UI can point at the editable input. */
  parameter?: string;
}

export interface ScenarioMonthResult {
  month: string;
  baselineRevenue: string;
  baselineExpenses: string;
  baselineNetProfit: string;
  scenarioRevenue: string;
  scenarioExpenses: string;
  scenarioNetProfit: string;
  netProfitDelta: string;
  cashTimingAdjustment: string;
  /** End-of-month run-rate cash. */
  baselineCash: string;
  scenarioCash: string;
}

export interface BreakEven {
  /** NOT_NEEDED: the scenario never costs anything month-to-month. REACHED: monthly impact turns non-negative. NOT_WITHIN_12_MONTHS: it doesn't within the window. */
  status: "NOT_NEEDED" | "REACHED" | "NOT_WITHIN_12_MONTHS";
  monthlyBreakEvenMonth: string | null;
  /** First month the CUMULATIVE impact is back to zero or better after having been negative. */
  cumulativePaybackMonth: string | null;
}

export interface ScenarioCaseSummary {
  twelveMonthRevenueDelta: string;
  twelveMonthExpenseDelta: string;
  twelveMonthNetProfitDelta: string;
  baselineNetProfit12m: string;
  scenarioNetProfit12m: string;
  baselineEndCash: string;
  scenarioEndCash: string;
  lowestScenarioCash: { month: string; balance: string };
  /** Months until run-rate cash goes below zero; null = it does not within the 12-month window. */
  baselineRunwayMonths: string | null;
  scenarioRunwayMonths: string | null;
  breakEven: BreakEven;
}

export interface ScenarioCaseResult {
  caseName: CaseName;
  assumptions: CaseAssumption[];
  months: ScenarioMonthResult[];
  summary: ScenarioCaseSummary;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** The next 12 full calendar months after the month containing `asOf`. */
export function projectionMonths(asOf: Date): Date[] {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  return Array.from({ length: PROJECTION_MONTHS }, (_, i) => new Date(Date.UTC(y, m + 1 + i, 1)));
}

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysInMonth(monthStart: Date): number {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
}

export function monthsBetween(fromMonthStart: Date, toMonthStart: Date): number {
  return (toMonthStart.getUTCFullYear() - fromMonthStart.getUTCFullYear()) * 12 + (toMonthStart.getUTCMonth() - fromMonthStart.getUTCMonth());
}

/**
 * Fraction of `monthStart`'s month during which something effective from
 * `effective` is in force: 1 if it already was before the month began, 0 if
 * it starts after the month ends, otherwise the days remaining from the
 * effective day inclusive over the days in the month.
 */
export function activeFraction(monthStart: Date, effective: Date): Decimal {
  const dim = daysInMonth(monthStart);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), dim));
  const eff = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth(), effective.getUTCDate()));
  if (eff.getTime() <= monthStart.getTime()) return new Decimal(1);
  if (eff.getTime() > monthEnd.getTime()) return new Decimal(0);
  return new Decimal(dim - eff.getUTCDate() + 1).div(dim);
}

function pct(value: string): Decimal {
  return new Decimal(value).div(100);
}

function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// Per-type monthly deltas
// ---------------------------------------------------------------------------

/** Fully loaded monthly cost of the hire: salary/12 × (1 + on-cost %). */
export function hireMonthlyCost(params: Pick<HireEmployeeParams, "annualSalary" | "onCostPercent">, currency: string): Money {
  return Money.of(new Decimal(params.annualSalary).div(12).times(new Decimal(1).plus(pct(params.onCostPercent))), currency);
}

function rampFactor(monthsSinceStart: number, rampMonths: number): Decimal {
  if (monthsSinceStart < 0) return new Decimal(0);
  if (rampMonths === 0) return new Decimal(1);
  return Decimal.min(1, new Decimal(monthsSinceStart + 1).div(rampMonths));
}

export function revenuePercentForCase(params: HireEmployeeParams, c: CaseName): string {
  if (c === "BEST") return params.bestRevenuePercentOfExpected;
  if (c === "WORST") return params.worstRevenuePercentOfExpected;
  return "100";
}

export function hireDeltas(params: HireEmployeeParams, c: CaseName, months: Date[], currency: string): MonthlyDelta[] {
  const start = parseDate(params.startDate);
  const startMonth = firstOfMonth(start);
  const monthlyCost = hireMonthlyCost(params, currency);
  const revPct = pct(revenuePercentForCase(params, c));
  const zero = Money.zero(currency);

  return months.map((month) => {
    const frac = activeFraction(month, start);
    const k = monthsBetween(startMonth, month);
    const revenue = Money.of(params.incrementalMonthlyRevenue, currency).multiply(revPct).multiply(rampFactor(k, params.rampMonths)).multiply(frac);
    return { revenueDelta: revenue, expenseDelta: monthlyCost.multiply(frac), cashTimingAdjustment: zero };
  });
}

/** Compounded revenue change factor for a price change with a volume change: (1+p)(1+v) − 1. */
export function priceRevenueFactor(priceChangePercent: string, volumeChangePercent: string): Decimal {
  return new Decimal(1).plus(pct(priceChangePercent)).times(new Decimal(1).plus(pct(volumeChangePercent))).minus(1);
}

export function volumeForCase(params: PriceChangeParams, c: CaseName): string {
  return c === "BEST" ? params.volumeChangePercent.best : c === "WORST" ? params.volumeChangePercent.worst : params.volumeChangePercent.expected;
}

/**
 * `scopeShare` (0–1) is the in-scope share of trailing-12-month revenue,
 * applied to each baseline month's revenue. `variableCostPercent` is the
 * share of revenue that is avoided cost when VOLUME changes (a price change
 * on unchanged volume has no cost effect).
 */
export function priceChangeDeltas(
  params: PriceChangeParams,
  c: CaseName,
  baseline: BaselineMonth[],
  scopeShare: Decimal,
  variableCostPercent: string,
  currency: string,
): MonthlyDelta[] {
  const effective = parseDate(params.effectiveDate);
  const volume = volumeForCase(params, c);
  const factor = priceRevenueFactor(params.priceChangePercent, volume);
  const volumeFraction = pct(volume);
  const costFraction = pct(variableCostPercent);
  const zero = Money.zero(currency);

  return baseline.map((b) => {
    const frac = activeFraction(b.monthStart, effective);
    const scoped = b.revenue.multiply(scopeShare).multiply(frac);
    return {
      revenueDelta: scoped.multiply(factor),
      // Volume lost (negative %) avoids cost, so the expense delta is negative then.
      expenseDelta: scoped.multiply(volumeFraction).multiply(costFraction),
      cashTimingAdjustment: zero,
    };
  });
}

export function loseCustomerDeltas(
  params: LoseCustomerParams,
  c: CaseName,
  baseline: BaselineMonth[],
  customerShare: Decimal,
  avoidedCostPercent: string,
  openReceivables: Money,
  currency: string,
): MonthlyDelta[] {
  const effective = parseDate(params.effectiveDate);
  const effectiveMonth = firstOfMonth(effective);
  const avoided = pct(avoidedCostPercent);
  const replacement = c === "BEST" ? pct(params.bestReplacementPercent) : new Decimal(0);
  const replacementStart = new Date(Date.UTC(effectiveMonth.getUTCFullYear(), effectiveMonth.getUTCMonth() + params.bestReplacementLagMonths, 1));
  const delay = c === "WORST" ? params.worstCollectionDelayMonths : 0;
  const zero = Money.zero(currency);

  return baseline.map((b) => {
    const lost = b.revenue.multiply(customerShare).multiply(activeFraction(b.monthStart, effective));
    const replaced = b.monthStart.getTime() >= replacementStart.getTime() ? lost.multiply(replacement) : zero;
    const netLost = lost.subtract(replaced);

    // Worst case only: the customer's open receivables are collected `delay` months late — in the base
    // path they arrive in the effective month. A pure timing shift: −O then, +O `delay` months later.
    let timing = zero;
    if (delay > 0 && openReceivables.isPositive()) {
      const offset = monthsBetween(effectiveMonth, b.monthStart);
      if (offset === 0) timing = timing.subtract(openReceivables);
      if (offset === delay) timing = timing.add(openReceivables);
    }

    return {
      revenueDelta: netLost.negate(),
      expenseDelta: netLost.multiply(avoided).negate(),
      cashTimingAdjustment: timing,
    };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Months until run-rate cash goes below zero, interpolating linearly inside
 * the month it crosses. `null` when it stays non-negative for the whole
 * window — "runway longer than the 12 months modelled", which is NOT the same
 * as "infinite", and the UI words it that way.
 */
export function runwayMonths(openingCash: Money, endCashByMonth: Money[]): string | null {
  if (openingCash.isNegative()) return "0.0";
  for (let k = 0; k < endCashByMonth.length; k += 1) {
    const prev = k === 0 ? openingCash : endCashByMonth[k - 1]!;
    const cur = endCashByMonth[k]!;
    if (cur.isNegative()) {
      const span = prev.subtract(cur).toDecimal();
      const within = span.isZero() ? new Decimal(0) : prev.toDecimal().div(span);
      return new Decimal(k).plus(within).toFixed(1);
    }
  }
  return null;
}

export function computeBreakEven(netDeltas: Money[], monthLabels: string[]): BreakEven {
  const firstNegative = netDeltas.findIndex((d) => d.isNegative());
  if (firstNegative === -1) return { status: "NOT_NEEDED", monthlyBreakEvenMonth: null, cumulativePaybackMonth: null };

  let monthly: string | null = null;
  for (let i = firstNegative + 1; i < netDeltas.length; i += 1) {
    if (!netDeltas[i]!.isNegative()) {
      monthly = monthLabels[i]!;
      break;
    }
  }

  let cumulative = Money.zero(netDeltas[0]!.currency);
  let payback: string | null = null;
  for (let i = 0; i < netDeltas.length; i += 1) {
    cumulative = cumulative.add(netDeltas[i]!);
    if (i > firstNegative && !cumulative.isNegative()) {
      payback = monthLabels[i]!;
      break;
    }
  }
  return { status: monthly ? "REACHED" : "NOT_WITHIN_12_MONTHS", monthlyBreakEvenMonth: monthly, cumulativePaybackMonth: payback };
}

export function monthLabel(monthStart: Date): string {
  return dateKey(monthStart).slice(0, 7);
}

/** Applies one case's monthly deltas to the baseline and derives every figure the results view shows. */
export function assembleCase(
  caseName: CaseName,
  assumptions: CaseAssumption[],
  baseline: BaselineMonth[],
  deltas: MonthlyDelta[],
  openingCash: Money,
): ScenarioCaseResult {
  const currency = openingCash.currency;
  let baselineCash = openingCash;
  let scenarioCash = openingCash;
  let baselineProfit = Money.zero(currency);
  let scenarioProfit = Money.zero(currency);
  let revDelta = Money.zero(currency);
  let expDelta = Money.zero(currency);
  const months: ScenarioMonthResult[] = [];
  const baselineEnd: Money[] = [];
  const scenarioEnd: Money[] = [];
  const netDeltas: Money[] = [];
  const labels: string[] = [];

  baseline.forEach((b, i) => {
    const d = deltas[i]!;
    const baseNet = b.revenue.subtract(b.expenses);
    const scenRevenue = b.revenue.add(d.revenueDelta);
    const scenExpenses = b.expenses.add(d.expenseDelta);
    const scenNet = scenRevenue.subtract(scenExpenses);
    const netDelta = scenNet.subtract(baseNet);

    baselineCash = baselineCash.add(baseNet);
    scenarioCash = scenarioCash.add(scenNet).add(d.cashTimingAdjustment);
    baselineProfit = baselineProfit.add(baseNet);
    scenarioProfit = scenarioProfit.add(scenNet);
    revDelta = revDelta.add(d.revenueDelta);
    expDelta = expDelta.add(d.expenseDelta);
    baselineEnd.push(baselineCash);
    scenarioEnd.push(scenarioCash);
    netDeltas.push(netDelta);
    labels.push(monthLabel(b.monthStart));

    months.push({
      month: monthLabel(b.monthStart),
      baselineRevenue: b.revenue.toString(),
      baselineExpenses: b.expenses.toString(),
      baselineNetProfit: baseNet.toString(),
      scenarioRevenue: scenRevenue.toString(),
      scenarioExpenses: scenExpenses.toString(),
      scenarioNetProfit: scenNet.toString(),
      netProfitDelta: netDelta.toString(),
      cashTimingAdjustment: d.cashTimingAdjustment.toString(),
      baselineCash: baselineCash.toString(),
      scenarioCash: scenarioCash.toString(),
    });
  });

  let lowIdx = 0;
  scenarioEnd.forEach((c, i) => {
    if (c.compareTo(scenarioEnd[lowIdx]!) < 0) lowIdx = i;
  });

  return {
    caseName,
    assumptions,
    months,
    summary: {
      twelveMonthRevenueDelta: revDelta.toString(),
      twelveMonthExpenseDelta: expDelta.toString(),
      twelveMonthNetProfitDelta: scenarioProfit.subtract(baselineProfit).toString(),
      baselineNetProfit12m: baselineProfit.toString(),
      scenarioNetProfit12m: scenarioProfit.toString(),
      baselineEndCash: baselineCash.toString(),
      scenarioEndCash: scenarioCash.toString(),
      lowestScenarioCash: { month: labels[lowIdx]!, balance: scenarioEnd[lowIdx]!.toString() },
      baselineRunwayMonths: runwayMonths(openingCash, baselineEnd),
      scenarioRunwayMonths: runwayMonths(openingCash, scenarioEnd),
      breakEven: computeBreakEven(netDeltas, labels),
    },
  };
}

/** `share` of `numerator / denominator` clamped to [0, 1]; 0 when there is no denominator. */
export function clampedShare(numerator: Money, denominator: Money): Decimal {
  if (!denominator.isPositive() || !numerator.isPositive()) return new Decimal(0);
  return Decimal.min(1, numerator.toDecimal().div(denominator.toDecimal()));
}
