import { describe, expect, it } from "vitest";
import {
  currentMonthRange,
  formatDateParam,
  parseDateParam,
  previousMonthRange,
  resolveComparisonRange,
  sameMonthLastYearRange,
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
});
