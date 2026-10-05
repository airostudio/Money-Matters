/**
 * Pure logic behind `BudgetService.createRollingForecast` — master spec
 * §36's "rolling forecast", built as an on-demand, user-triggered action
 * ("create a rolling forecast from budget X, carrying forward periods
 * after date Y"), never a scheduled/automatic rolling window — no job
 * queue exists in this codebase (the same recurring-process gap every
 * other on-demand action here already documents, e.g.
 * `DepreciationService.runForPeriod`).
 *
 * No database access, no side effects — `BudgetService.createRollingForecast`
 * loads the source budget's lines, calls this, and writes the result as the
 * new budget's lines. Kept separate so the "which lines count as past vs.
 * future" boundary is unit-testable against hand-built inputs.
 */

export interface RollingForecastSourceLine {
  accountId: string;
  dimensionValueId: string | null;
  /** ISO date string (first day of month). */
  periodStart: string;
  /** ISO date string (last day of month). */
  periodEnd: string;
  amount: string;
}

export interface PartitionedRollingForecastLines {
  /** Lines whose period ends on/before the cutoff — copied through unchanged, preserving history. */
  past: RollingForecastSourceLine[];
  /** Lines whose period starts after the cutoff — carried forward as the new budget's starting point, to be edited by the user. */
  future: RollingForecastSourceLine[];
}

/**
 * Splits `sourceLines` into "past" (on/before `carryForwardAfterDate`,
 * preserved as-is) and "future" (strictly after it, carried forward
 * unedited until the user changes them) — the entire mechanic a rolling
 * forecast needs. A line cannot straddle the cutoff: this slice's lines are
 * always a single calendar month (see `budgetLines`'s doc comment in
 * src/db/schema.ts), so `periodStart`/`periodEnd` fall entirely on one side
 * or the other for any cutoff date, which this function asserts rather than
 * silently guessing which side a straddling line belongs to.
 */
export function partitionLinesForRollingForecast(
  sourceLines: RollingForecastSourceLine[],
  carryForwardAfterDate: Date,
): PartitionedRollingForecastLines {
  const cutoff = carryForwardAfterDate.getTime();
  const past: RollingForecastSourceLine[] = [];
  const future: RollingForecastSourceLine[] = [];

  for (const line of sourceLines) {
    const start = new Date(line.periodStart).getTime();
    const end = new Date(line.periodEnd).getTime();
    if (end <= cutoff) {
      past.push(line);
    } else if (start > cutoff) {
      future.push(line);
    } else {
      throw new Error(
        `Budget line for period ${line.periodStart}–${line.periodEnd} straddles the carry-forward cutoff ` +
          `${carryForwardAfterDate.toISOString().slice(0, 10)} — cutoff must fall on a calendar-month boundary.`,
      );
    }
  }

  return { past, future };
}
