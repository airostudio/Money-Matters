import { Money } from "@/domain/money/money";

export interface ProjectFinancials {
  revenue: string;
  cost: string;
}

export interface ProjectFinancialSummary {
  revenue: string;
  cost: string;
  profit: string;
  /** Decimal string fraction, e.g. "0.3500" for 35%. Null when revenue is zero (division is undefined, not zero). */
  margin: string | null;
}

export interface CostBreakdownLine {
  label: string;
  estimated: string;
  actual: string;
}

export interface CostBreakdownVariance extends CostBreakdownLine {
  variance: string;
  explanation: string;
}

export interface ProjectVarianceInput {
  currency: string;
  estimated: ProjectFinancials;
  actual: ProjectFinancials;
  /**
   * Optional cost sub-totals (e.g. "Labour", "Materials/Subcontractors")
   * whose variances get their own plain-language line, per master spec
   * §22's example ("Labour exceeded estimate by $3,200"). `actual`'s total
   * across all lines need not equal `actual.cost` above — a breakdown line
   * may legitimately be revenue-only or omitted entirely where no estimate
   * exists to compare against (see docs/roadmap.md's note on labour cost
   * being scoped out of Actual Cost in this slice).
   */
  costBreakdown?: CostBreakdownLine[];
}

export interface ProjectVarianceResult {
  estimated: ProjectFinancialSummary;
  actual: ProjectFinancialSummary;
  variance: {
    revenue: string;
    cost: string;
    profit: string;
  };
  costBreakdown: CostBreakdownVariance[];
  /** Plain-language sentences summarizing the variance — revenue/cost/profit plus one per `costBreakdown` line. */
  explanations: string[];
}

function summarize(currency: string, revenue: string, cost: string): ProjectFinancialSummary {
  const r = Money.of(revenue, currency);
  const c = Money.of(cost, currency);
  const profit = r.subtract(c);
  const margin = r.isZero() ? null : profit.toDecimal().div(r.toDecimal()).toFixed(4);
  return { revenue: r.toString(), cost: c.toString(), profit: profit.toString(), margin };
}

function describeVariance(label: string, estimated: string, actual: string, currency: string, higherIsBad: boolean): string {
  const est = Money.of(estimated, currency);
  const act = Money.of(actual, currency);
  const diff = act.subtract(est);
  if (diff.isZero()) return `${label} is exactly on budget.`;
  const over = diff.toDecimal().isPositive();
  const verb = higherIsBad ? (over ? "exceeded" : "came in under") : over ? "came in above" : "came in below";
  const absolute = Money.of(diff.toDecimal().abs(), currency).toString();
  return `${label} ${verb} estimate by ${absolute}.`;
}

/**
 * Master spec §22's Estimated vs. Actual comparison: Revenue/Cost/Profit/
 * Margin on both sides, the variance between them, and a plain-language
 * explanation per line — e.g. "Labour exceeded estimate by $3,200." Pulled
 * out as a pure function (no DB access) so the arithmetic — Money-safe
 * division for margin, signed variance, over/under wording — is unit
 * tested directly; `profitability-service.ts` is the only caller that
 * supplies real numbers, sourced from posted ledger activity rather than
 * fabricated.
 */
export function computeProjectVariance(input: ProjectVarianceInput): ProjectVarianceResult {
  const estimated = summarize(input.currency, input.estimated.revenue, input.estimated.cost);
  const actual = summarize(input.currency, input.actual.revenue, input.actual.cost);

  const variance = {
    revenue: Money.of(actual.revenue, input.currency).subtract(Money.of(estimated.revenue, input.currency)).toString(),
    cost: Money.of(actual.cost, input.currency).subtract(Money.of(estimated.cost, input.currency)).toString(),
    profit: Money.of(actual.profit, input.currency).subtract(Money.of(estimated.profit, input.currency)).toString(),
  };

  const explanations = [
    describeVariance("Revenue", estimated.revenue, actual.revenue, input.currency, false),
    describeVariance("Cost", estimated.cost, actual.cost, input.currency, true),
    describeVariance("Profit", estimated.profit, actual.profit, input.currency, false),
  ];

  const costBreakdown: CostBreakdownVariance[] = (input.costBreakdown ?? []).map((line) => ({
    ...line,
    variance: Money.of(line.actual, input.currency).subtract(Money.of(line.estimated, input.currency)).toString(),
    explanation: describeVariance(line.label, line.estimated, line.actual, input.currency, true),
  }));

  return {
    estimated,
    actual,
    variance,
    costBreakdown,
    explanations: [...explanations, ...costBreakdown.map((l) => l.explanation)],
  };
}
