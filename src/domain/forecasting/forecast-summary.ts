import type { CashForecast } from "./types";

const ZERO = "0.0000";

/**
 * One sentence describing the known amounts that have no determinable date
 * (kept off both timelines), or `null` when there are none. Built only from
 * what the forecast actually contains: payroll is mentioned only when the
 * forecast has payroll liabilities in it, so an actor whose payroll lines
 * were omitted (`payrollOmitted`) never gets a hint of them from this text.
 */
export function describeUnscheduledKnown(f: CashForecast): string | null {
  const parts: string[] = [];
  if (f.unscheduledKnown.inflows !== ZERO) {
    parts.push(`${f.unscheduledKnown.inflows} owed to the business (overdue receivables)`);
  }
  if (f.unscheduledKnown.outflows !== ZERO) {
    parts.push(`${f.unscheduledKnown.outflows} owed by the business (payroll liabilities whose due dates are not verified)`);
  }
  if (parts.length === 0) return null;

  const floor =
    f.unscheduledKnown.outflows !== ZERO
      ? ` If those outflows were all paid immediately, the known-only low point would be ${f.unscheduledKnown.lowPointIfUnscheduledOutflowsPaidNow}.`
      : "";
  return `Known amounts with NO determinable date (kept off both projections): ${parts.join("; ")}.${floor}`;
}
