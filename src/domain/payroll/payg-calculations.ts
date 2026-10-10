import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import { BracketCalculations, type TaxBracket } from "./bracket-calculations";

export type PayFrequency = "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";

/** Pay periods per year for each supported frequency — master spec §8 asks for at least weekly/fortnightly; monthly is included too since it costs nothing extra once the annualize/de-annualize math is generic. */
export const PAY_PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  WEEKLY: 52,
  FORTNIGHTLY: 26,
  MONTHLY: 12,
};

export interface MedicareLevyRule {
  /** Decimal string, e.g. "0.0200". */
  rate: string;
  /** Decimal string — nil levy strictly below this annual taxable income. */
  lowerThreshold: string;
  /** Decimal string — full standard rate at/above this annual taxable income. */
  upperThreshold: string;
}

/**
 * Drops the resident tax-free threshold's nil band for an employee who has
 * declared they are NOT claiming it on their TFN declaration — this slice's
 * one approximation of the ATO's separate "no tax-free threshold" withholding
 * schedule (see this module's doc comment for what is and isn't attempted).
 * Concretely: the 0%-rate bracket is removed and the next bracket's
 * threshold is pulled down to $0, so that bracket's marginal rate applies
 * from the first dollar instead of only above $18,200. This is a documented
 * simplification, not the ATO's actual no-threshold coefficients (which this
 * slice does not have verified figures for) — see docs/roadmap.md.
 */
export function withoutTaxFreeThreshold(brackets: TaxBracket[]): TaxBracket[] {
  const sorted = [...brackets].sort((a, b) => a.sequence - b.sequence);
  if (sorted.length < 2 || sorted[0]!.marginalRate !== "0.0000") return sorted;
  const [, second, ...rest] = sorted;
  return [{ sequence: 0, threshold: "0.0000", marginalRate: second!.marginalRate }, ...rest].map((b, i) => ({
    ...b,
    sequence: i,
  }));
}

/**
 * Standard nil-below/full-above step function for the Medicare levy's
 * low-income reduction, plus the optional linear phase-in between the two
 * thresholds (`(annualIncome - lowerThreshold) × 0.10`, capped at the
 * standard levy amount). VERIFIED in Phase 8 Slice 4(f): the 2025-26 singles
 * thresholds ($28,011 / $35,013) are on the ATO's "Medicare levy reduction"
 * pages, and the 10 cents per dollar over the lower threshold shade-in capped
 * at the standard 2% (so the cap bites at about 1.25 x the lower threshold) is
 * described consistently by pay-calculator-australia.com, canstar.com.au and
 * money-snap.com (see docs/roadmap.md). The 2026-27 thresholds were NOT
 * published when this was checked; the FY2026-27 rule sets carry the 2025-26
 * figures with a verification note. Returns the ANNUAL levy amount as a Decimal.
 */
export function annualMedicareLevy(rule: MedicareLevyRule, annualTaxableIncome: Decimal): Decimal {
  const lower = new Decimal(rule.lowerThreshold);
  const upper = new Decimal(rule.upperThreshold);
  const rate = new Decimal(rule.rate);
  const fullLevy = annualTaxableIncome.times(rate);

  if (annualTaxableIncome.lessThanOrEqualTo(lower)) return new Decimal(0);
  if (annualTaxableIncome.greaterThanOrEqualTo(upper)) return fullLevy;

  const phaseIn = annualTaxableIncome.minus(lower).times("0.10");
  return Decimal.min(phaseIn, fullLevy);
}

export interface PaygWithholdingInput {
  /** Decimal string — gross pay for ONE pay period (already pro-rated for hours/salary). */
  grossPayForPeriod: string;
  payFrequency: PayFrequency;
  taxFreeThresholdClaimed: boolean;
  brackets: TaxBracket[];
  medicareLevy: MedicareLevyRule;
  /**
   * Phase 8 Slice 4(c). `FOREIGN_RESIDENT` uses `foreignResidentBrackets` (no tax-free threshold, so `taxFreeThresholdClaimed`
   * is ignored) and charges NO Medicare levy. Defaults to `RESIDENT`. If `FOREIGN_RESIDENT` is requested without foreign
   * resident brackets the calculation REFUSES (throws) rather than falling back to resident rates.
   */
  residency?: "RESIDENT" | "FOREIGN_RESIDENT";
  foreignResidentBrackets?: TaxBracket[];
}

export class ForeignResidentRatesMissingError extends Error {
  constructor() {
    super(
      "This employee is a foreign resident but the resolved rule set has no foreign resident rates. Withholding is refused rather than approximated with resident rates.",
    );
    this.name = "ForeignResidentRatesMissingError";
  }
}

/**
 * PAYG withholding via the **annualized-bracket method**: annualize this
 * period's gross pay (× pay periods/year), apply the resolved rule set's
 * brackets (dropping the tax-free threshold's nil band if not claimed) to
 * get annual tax, add the annual Medicare levy, then divide back down to a
 * per-period amount.
 *
 * **This is a standard, ATO-acknowledged-as-acceptable approximation
 * method, NOT a byte-for-byte implementation of the ATO's published NAT
 * 1004 per-period coefficient tables** — those could not be independently
 * fetched/verified during this slice's research (ato.gov.au blocked direct
 * fetching). Minor rounding differences from the official published
 * per-period lookup tables are expected and accepted under the ATO's own
 * Schedule 1 documentation of acceptable withholding methods. **A
 * registered tax agent or payroll provider should verify this software's
 * output against real ATO tables before it is used for real employee
 * payroll** — this disclaimer is also shown in the payroll UI itself (see
 * the pay run and payslip pages), not just here.
 */
export function calculatePaygWithholding(input: PaygWithholdingInput): Decimal {
  const periodsPerYear = PAY_PERIODS_PER_YEAR[input.payFrequency];
  const grossPay = new Decimal(input.grossPayForPeriod);
  const annualized = grossPay.times(periodsPerYear);

  const foreign = input.residency === "FOREIGN_RESIDENT";
  if (foreign && (!input.foreignResidentBrackets || input.foreignResidentBrackets.length === 0)) {
    throw new ForeignResidentRatesMissingError();
  }
  const brackets = foreign
    ? input.foreignResidentBrackets!
    : input.taxFreeThresholdClaimed
      ? input.brackets
      : withoutTaxFreeThreshold(input.brackets);
  const annualIncomeTax = BracketCalculations.annualTax(brackets, annualized);
  // Foreign residents are not liable for the Medicare levy (ATO foreign resident tax rates page; ozcalc.com.au; taxbne.com.au).
  const annualLevy = foreign ? new Decimal(0) : annualMedicareLevy(input.medicareLevy, annualized);

  const annualWithholding = annualIncomeTax.plus(annualLevy);
  const periodWithholding = annualWithholding.dividedBy(periodsPerYear);

  // Never withhold more than the gross pay itself, and never a negative
  // amount (a $0 or near-zero gross period must withhold $0, not a rounding
  // artifact in either direction).
  const clamped = Decimal.max(0, Decimal.min(periodWithholding, grossPay));
  return clamped.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
}

/** Convenience wrapper returning a `Money`-ready decimal string at ledger precision. */
export function calculatePaygWithholdingString(input: PaygWithholdingInput, currency: string): string {
  return Money.of(calculatePaygWithholding(input), currency).toString();
}
