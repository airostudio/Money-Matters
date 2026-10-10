import Decimal from "decimal.js";

export interface SuperGuaranteeInput {
  /** Decimal string — this pay run's ordinary time earnings for this employee. */
  ordinaryTimeEarningsForPeriod: string;
  /** Decimal string — this employee's OTE already recorded for the current quarter, BEFORE this run. "0" for the first run of a new quarter. */
  quarterToDateOteBefore: string;
  /** Decimal string, e.g. "0.1200" for 12%. */
  sgRate: string;
  /**
   * Decimal string, or null. Null means this rule set's quarterly
   * contribution-base cap mechanics are themselves unresolved (see
   * `payrollTaxRuleSets.sgQuarterlyContributionBaseCap`'s schema comment)
   * — this function then applies the rate with NO cap rather than
   * fabricating one, and the caller is expected to have already surfaced
   * that rule set's `requiresVerificationNote` prominently.
   */
  quarterlyContributionBaseCap: string | null;
}

export interface SuperGuaranteeResult {
  /** Decimal — quarterToDateOteBefore + this period's OTE. */
  quarterToDateOteAfter: Decimal;
  /** Decimal — the portion of this period's OTE still subject to SG after applying the quarterly cap (may be less than the period's full OTE if the cap is reached mid-period). */
  oteSubjectToSg: Decimal;
  /** Decimal — sgRate × oteSubjectToSg. */
  superGuaranteeAmount: Decimal;
}

/**
 * Superannuation Guarantee (master spec §8) — `sgRate × OTE`, capped so that
 * SG is only mandatory on an employee's ordinary time earnings up to the
 * quarterly contribution base for the financial year their pay date falls
 * in (source: ato.gov.au "Super guarantee" page — see docs/roadmap.md for
 * the exact cited figures). Tracking is DONE PER PAY RUN against
 * quarter-to-date OTE already recorded on this employee's prior
 * `pay_run_lines` rows in the same quarter — see `PayRunService` for how
 * that running total is read back, not recomputed by guesswork.
 *
 * If this period's OTE pushes the employee's quarter-to-date OTE past the
 * cap, only the portion up to the cap is SG-liable this period — not the
 * whole period's OTE and not zero. An employee already at/above the cap
 * before this period correctly contributes $0 additional SG for this run.
 */
export function calculateSuperGuarantee(input: SuperGuaranteeInput): SuperGuaranteeResult {
  const periodOte = new Decimal(input.ordinaryTimeEarningsForPeriod);
  const before = new Decimal(input.quarterToDateOteBefore);
  const after = before.plus(periodOte);

  let oteSubjectToSg = periodOte;
  if (input.quarterlyContributionBaseCap !== null) {
    const cap = new Decimal(input.quarterlyContributionBaseCap);
    const remainingRoom = Decimal.max(0, cap.minus(before));
    oteSubjectToSg = Decimal.min(periodOte, remainingRoom);
  }

  const superGuaranteeAmount = oteSubjectToSg
    .times(input.sgRate)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);

  return { quarterToDateOteAfter: after, oteSubjectToSg, superGuaranteeAmount };
}

/**
 * The calendar-quarter start date (UTC) for a given pay date, under the
 * standard Jul–Sep / Oct–Dec / Jan–Mar / Apr–Jun SG quarters (these align
 * with the calendar quarter, not the financial year's quarter numbering —
 * the long-standing SG quarterly cadence this slice builds, per the brief's
 * explicit instruction NOT to implement Payday Super's per-payday model).
 */
export function sgQuarterStart(payDate: Date): Date {
  const month = payDate.getUTCMonth(); // 0-11
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(Date.UTC(payDate.getUTCFullYear(), quarterStartMonth, 1));
}
