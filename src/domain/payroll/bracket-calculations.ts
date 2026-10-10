import Decimal from "decimal.js";

/** One marginal-rate row — mirrors `payrollTaxBrackets`, decimal strings only. */
export interface TaxBracket {
  sequence: number;
  /** Decimal string — the lower bound of annual income this rate first applies above. */
  threshold: string;
  /** Decimal string, e.g. "0.3000" for 30%. */
  marginalRate: string;
}

/**
 * Pure bracket math for a resident individual income tax schedule (master
 * spec §24). The schema deliberately stores only `(threshold, marginalRate)`
 * per bracket — never a hardcoded "plus $X" cumulative base — so that a
 * future year's rule set only ever needs its marginal rates/thresholds
 * entered, with every cumulative amount derived here and therefore
 * self-consistent by construction. See `src/tests/unit/payroll/
 * bracket-calculations.test.ts`, which independently reproduces this
 * slice's hand-derived FY2026-27 figures ($4,020/$31,020/$51,370) from
 * nothing but the marginal rates/thresholds — a mismatch there is a bug in
 * the verified source figures to investigate, never something to "fix" by
 * changing them.
 */
export const BracketCalculations = {
  /**
   * The cumulative tax payable at exactly `bracket.threshold` — i.e. the
   * "plus $X" constant for this bracket — derived by summing every lower
   * bracket's full width × its own marginal rate. Brackets must be passed
   * in ascending `sequence`/`threshold` order (the seeded data already is;
   * this function does not re-sort, so a caller passing them out of order
   * gets a wrong answer rather than a silently "corrected" one).
   */
  cumulativeBaseAt(brackets: TaxBracket[], bracketIndex: number): Decimal {
    let base = new Decimal(0);
    for (let i = 0; i < bracketIndex; i++) {
      const current = brackets[i]!;
      const next = brackets[i + 1];
      if (!next) break; // Only the top bracket has no next — never reached since bracketIndex > i.
      const width = new Decimal(next.threshold).minus(current.threshold);
      base = base.plus(width.times(current.marginalRate));
    }
    return base;
  },

  /**
   * Annual tax payable on `annualIncome` under this bracket schedule — the
   * standard "nil up to threshold, then cumulative base plus marginal rate
   * on the excess" formula, computed without ever reading a hardcoded
   * cumulative constant. Returns a Decimal, never a string, so callers can
   * keep combining it (e.g. adding the Medicare levy) before rounding once
   * at the very end — see `PaygCalculations`.
   */
  annualTax(brackets: TaxBracket[], annualIncome: Decimal): Decimal {
    const sorted = [...brackets].sort((a, b) => a.sequence - b.sequence);
    let applicable = sorted[0]!;
    let applicableIndex = 0;
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i]!;
      if (annualIncome.greaterThanOrEqualTo(b.threshold)) {
        applicable = b;
        applicableIndex = i;
      } else {
        break;
      }
    }
    const base = BracketCalculations.cumulativeBaseAt(sorted, applicableIndex);
    const excess = annualIncome.minus(applicable.threshold);
    return base.plus(excess.times(applicable.marginalRate));
  },
};
