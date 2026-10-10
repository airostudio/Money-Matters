import { describe, expect, it } from "vitest";
import { partitionLinesForRollingForecast, type RollingForecastSourceLine } from "@/domain/budgeting/rolling-forecast";

function line(month: string, amount: string, accountId = "acc-1"): RollingForecastSourceLine {
  // month like "2026-03" -> first/last day of that calendar month.
  const [y, m] = month.split("-").map(Number);
  const periodStart = new Date(Date.UTC(y!, m! - 1, 1));
  const periodEnd = new Date(Date.UTC(y!, m!, 0));
  return {
    accountId,
    dimensionValueId: null,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    amount,
  };
}

describe("partitionLinesForRollingForecast", () => {
  it("preserves every line on/before the cutoff as past, unchanged", () => {
    const lines = [line("2026-01", "100.00"), line("2026-02", "100.00"), line("2026-03", "100.00")];
    const cutoff = new Date(Date.UTC(2026, 1, 28)); // end of Feb
    const { past, future } = partitionLinesForRollingForecast(lines, cutoff);

    expect(past.map((l) => l.periodStart)).toEqual([lines[0]!.periodStart, lines[1]!.periodStart]);
    expect(future.map((l) => l.periodStart)).toEqual([lines[2]!.periodStart]);
  });

  it("carries forward every line strictly after the cutoff into future, unedited", () => {
    const lines = [line("2026-06", "500.00"), line("2026-07", "500.00")];
    const cutoff = new Date(Date.UTC(2026, 4, 31)); // end of May — both months are after it
    const { past, future } = partitionLinesForRollingForecast(lines, cutoff);

    expect(past).toHaveLength(0);
    expect(future).toHaveLength(2);
    expect(future[0]!.amount).toBe("500.00");
  });

  it("treats a cutoff exactly on a line's periodEnd as making that line 'past'", () => {
    const l = line("2026-04", "250.00");
    const cutoff = new Date(l.periodEnd);
    const { past, future } = partitionLinesForRollingForecast([l], cutoff);
    expect(past).toHaveLength(1);
    expect(future).toHaveLength(0);
  });

  it("throws if a line straddles the cutoff (not a calendar-month boundary)", () => {
    const l = line("2026-05", "300.00");
    const midMonthCutoff = new Date(Date.UTC(2026, 4, 15));
    expect(() => partitionLinesForRollingForecast([l], midMonthCutoff)).toThrow(/straddles/);
  });

  it("handles an empty source line set", () => {
    const { past, future } = partitionLinesForRollingForecast([], new Date());
    expect(past).toHaveLength(0);
    expect(future).toHaveLength(0);
  });
});
