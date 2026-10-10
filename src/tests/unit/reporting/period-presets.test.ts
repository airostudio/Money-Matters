import { describe, expect, it } from "vitest";
import {
  currentMonthRange,
  formatDateParam,
  lastNMonths,
  lastNQuarters,
  monthlyColumns,
  parseDateParam,
  previousMonthRange,
  previousQuarterRange,
  quarterlyColumns,
  resolveComparisonRange,
  sameMonthLastYearRange,
  singleColumn,
  currentQuarterRange,
} from "@/domain/reporting/period-presets";

describe("period-presets", () => {
  it("computes the current calendar month's boundaries", () => {
    const range = currentMonthRange(new Date(Date.UTC(2026, 5, 15))); // June 15, 2026
    expect(formatDateParam(range.from)).toBe("2026-06-01");
    expect(formatDateParam(range.to)).toBe("2026-06-30");
  });

  it("handles the January → December year rollback", () => {
    const january = currentMonthRange(new Date(Date.UTC(2026, 0, 10)));
    const previous = previousMonthRange(january);
    expect(formatDateParam(previous.from)).toBe("2025-12-01");
    expect(formatDateParam(previous.to)).toBe("2025-12-31");
  });

  it("handles a leap-year February correctly", () => {
    const march2024 = currentMonthRange(new Date(Date.UTC(2024, 2, 5)));
    const feb = previousMonthRange(march2024);
    expect(formatDateParam(feb.to)).toBe("2024-02-29");
  });

  it("computes the same month one year earlier", () => {
    const range = currentMonthRange(new Date(Date.UTC(2026, 5, 15)));
    const lastYear = sameMonthLastYearRange(range);
    expect(formatDateParam(lastYear.from)).toBe("2025-06-01");
    expect(formatDateParam(lastYear.to)).toBe("2025-06-30");
  });

  it("resolveComparisonRange returns undefined for 'none'", () => {
    const range = currentMonthRange(new Date(Date.UTC(2026, 5, 15)));
    expect(resolveComparisonRange(range, "none")).toBeUndefined();
  });

  it("parseDateParam rejects malformed input instead of returning an invalid Date", () => {
    expect(parseDateParam("not-a-date")).toBeUndefined();
    expect(parseDateParam(undefined)).toBeUndefined();
    expect(formatDateParam(parseDateParam("2026-03-05")!)).toBe("2026-03-05");
  });

  describe("monthlyColumns (Phase 5 Slice 2 report builder)", () => {
    it("splits a multi-month range into one column per calendar month", () => {
      const columns = monthlyColumns({ from: parseDateParam("2026-01-01")!, to: parseDateParam("2026-03-31")! });
      expect(columns.map((c) => c.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
      expect(formatDateParam(columns[0]!.from)).toBe("2026-01-01");
      expect(formatDateParam(columns[0]!.to)).toBe("2026-01-31");
      expect(formatDateParam(columns[2]!.to)).toBe("2026-03-31");
    });

    it("clips the first and last columns to the requested range, not the full calendar month", () => {
      const columns = monthlyColumns({ from: parseDateParam("2026-01-15")!, to: parseDateParam("2026-02-10")! });
      expect(columns).toHaveLength(2);
      expect(formatDateParam(columns[0]!.from)).toBe("2026-01-15");
      expect(formatDateParam(columns[0]!.to)).toBe("2026-01-31");
      expect(formatDateParam(columns[1]!.from)).toBe("2026-02-01");
      expect(formatDateParam(columns[1]!.to)).toBe("2026-02-10");
    });

    it("handles a single-day range within one month", () => {
      const columns = monthlyColumns({ from: parseDateParam("2026-06-15")!, to: parseDateParam("2026-06-15")! });
      expect(columns).toHaveLength(1);
      expect(columns[0]!.label).toMatch(/^June? 2026$/);
    });
  });

  describe("quarterlyColumns", () => {
    it("splits a full year into four quarters", () => {
      const columns = quarterlyColumns({ from: parseDateParam("2026-01-01")!, to: parseDateParam("2026-12-31")! });
      expect(columns.map((c) => c.label)).toEqual(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
      expect(formatDateParam(columns[0]!.from)).toBe("2026-01-01");
      expect(formatDateParam(columns[0]!.to)).toBe("2026-03-31");
      expect(formatDateParam(columns[3]!.to)).toBe("2026-12-31");
    });

    it("clips a quarter straddling the range boundary", () => {
      const columns = quarterlyColumns({ from: parseDateParam("2026-02-15")!, to: parseDateParam("2026-02-20")! });
      expect(columns).toHaveLength(1);
      expect(columns[0]!.label).toBe("Q1 2026");
      expect(formatDateParam(columns[0]!.from)).toBe("2026-02-15");
      expect(formatDateParam(columns[0]!.to)).toBe("2026-02-20");
    });
  });

  it("singleColumn returns exactly one column spanning the whole range", () => {
    const range = { from: parseDateParam("2026-01-01")!, to: parseDateParam("2026-03-31")! };
    const columns = singleColumn(range);
    expect(columns).toHaveLength(1);
    expect(columns[0]!.from).toBe(range.from);
    expect(columns[0]!.to).toBe(range.to);
  });

  it("lastNMonths spans the last N whole calendar months ending in the current month", () => {
    const range = lastNMonths(3, new Date(Date.UTC(2026, 5, 15))); // June 2026
    expect(formatDateParam(range.from)).toBe("2026-04-01");
    expect(formatDateParam(range.to)).toBe("2026-06-30");
  });

  it("lastNQuarters spans the last N whole calendar quarters ending in the current quarter", () => {
    const range = lastNQuarters(2, new Date(Date.UTC(2026, 5, 15))); // Q2 2026
    expect(formatDateParam(range.from)).toBe("2026-01-01");
    expect(formatDateParam(range.to)).toBe("2026-06-30");
  });

  it("currentQuarterRange and previousQuarterRange handle the Q1 -> prior-year-Q4 rollback", () => {
    const q1 = currentQuarterRange(new Date(Date.UTC(2026, 1, 10))); // Feb 2026
    expect(formatDateParam(q1.from)).toBe("2026-01-01");
    expect(formatDateParam(q1.to)).toBe("2026-03-31");

    const priorQuarter = previousQuarterRange(q1);
    expect(formatDateParam(priorQuarter.from)).toBe("2025-10-01");
    expect(formatDateParam(priorQuarter.to)).toBe("2025-12-31");
  });
});
