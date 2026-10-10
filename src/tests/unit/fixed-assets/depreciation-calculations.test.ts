import { describe, expect, it } from "vitest";
import {
  calculateStraightLineDepreciation,
  projectDepreciationSchedule,
} from "@/domain/fixed-assets/depreciation-calculations";
import { InvalidDepreciationRunError } from "@/domain/fixed-assets/errors";

function monthBounds(year: number, monthIndex0: number) {
  return {
    periodStart: new Date(Date.UTC(year, monthIndex0, 1)),
    periodEnd: new Date(Date.UTC(year, monthIndex0 + 1, 0)),
  };
}

describe("straight-line depreciation", () => {
  it("charges one even monthly amount for an asset acquired on the first day of the period", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 1); // February 2026
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "12000.00",
      residualValue: "0",
      usefulLifeMonths: 60,
      accumulatedDepreciationBefore: "200.0000", // January already run
      periodStart,
      periodEnd,
    });

    // (12000 - 0) / 60 = 200.00 per month, flat.
    expect(result.amount).toBe("200.0000");
    expect(result.accumulatedDepreciationAfter).toBe("400.0000");
  });

  it("subtracts residual value from the depreciable base", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 0);
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "12000.00",
      residualValue: "2400.00",
      usefulLifeMonths: 60,
      accumulatedDepreciationBefore: "0",
      periodStart,
      periodEnd,
    });

    // (12000 - 2400) / 60 = 160.00 per month.
    expect(result.amount).toBe("160.0000");
  });

  it("prorates the first period by whole days when acquired mid-month", () => {
    // Acquired 2026-01-16, a 31-day January: 16 days served (16th..31st inclusive).
    const { periodStart, periodEnd } = monthBounds(2026, 0);
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2026-01-16"),
      acquisitionCost: "6200.00",
      residualValue: "200.00",
      usefulLifeMonths: 60,
      accumulatedDepreciationBefore: "0",
      periodStart,
      periodEnd,
    });

    // Monthly = (6200-200)/60 = 100.00. Prorated: 100 * 16/31 = 51.6129...
    expect(result.amount).toBe("51.6129");
  });

  it("charges nothing for a period before the asset was acquired", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 0); // January
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2026-02-01"),
      acquisitionCost: "12000.00",
      residualValue: "0",
      usefulLifeMonths: 60,
      accumulatedDepreciationBefore: "0",
      periodStart,
      periodEnd,
    });

    expect(result.amount).toBe("0.0000");
    expect(result.accumulatedDepreciationAfter).toBe("0.0000");
  });

  it("caps the final period's charge at the remaining depreciable base, never overshooting", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 11); // the 60th month
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2022-01-01"),
      acquisitionCost: "12000.00",
      residualValue: "0",
      usefulLifeMonths: 60,
      // 59 months already run at 200.00 each = 11800.00, only 200.00 left.
      accumulatedDepreciationBefore: "11800.0000",
      periodStart,
      periodEnd,
    });

    expect(result.amount).toBe("200.0000");
    expect(result.accumulatedDepreciationAfter).toBe("12000.0000");
  });

  it("charges nothing once fully depreciated, regardless of how many periods are run after", () => {
    const { periodStart, periodEnd } = monthBounds(2027, 0);
    const result = calculateStraightLineDepreciation({
      acquisitionDate: new Date("2022-01-01"),
      acquisitionCost: "12000.00",
      residualValue: "0",
      usefulLifeMonths: 60,
      accumulatedDepreciationBefore: "12000.0000",
      periodStart,
      periodEnd,
    });

    expect(result.amount).toBe("0.0000");
    expect(result.accumulatedDepreciationAfter).toBe("12000.0000");
  });

  it("rejects a non-positive useful life", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 0);
    expect(() =>
      calculateStraightLineDepreciation({
        acquisitionDate: new Date("2026-01-01"),
        acquisitionCost: "1200.00",
        residualValue: "0",
        usefulLifeMonths: 0,
        accumulatedDepreciationBefore: "0",
        periodStart,
        periodEnd,
      }),
    ).toThrow(InvalidDepreciationRunError);
  });

  it("rejects a residual value greater than acquisition cost", () => {
    const { periodStart, periodEnd } = monthBounds(2026, 0);
    expect(() =>
      calculateStraightLineDepreciation({
        acquisitionDate: new Date("2026-01-01"),
        acquisitionCost: "1000.00",
        residualValue: "1500.00",
        usefulLifeMonths: 12,
        accumulatedDepreciationBefore: "0",
        periodStart,
        periodEnd,
      }),
    ).toThrow(InvalidDepreciationRunError);
  });
});

describe("projected depreciation schedule", () => {
  it("produces exactly usefulLifeMonths rows, fully depreciating to residual value", () => {
    const schedule = projectDepreciationSchedule({
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "12000.00",
      residualValue: "0",
      usefulLifeMonths: 12,
    });

    expect(schedule).toHaveLength(12);
    expect(schedule[0]!.amount).toBe("1000.0000");
    expect(schedule.at(-1)!.accumulatedDepreciationAfter).toBe("12000.0000");
    expect(schedule.at(-1)!.netBookValueAfter).toBe("0.0000");
  });

  it("prorates the first row for a mid-month acquisition, needing one extra period to fully depreciate", () => {
    const schedule = projectDepreciationSchedule({
      acquisitionDate: new Date("2026-01-16"),
      acquisitionCost: "6200.00",
      residualValue: "200.00",
      usefulLifeMonths: 60,
    });

    expect(schedule[0]!.amount).toBe("51.6129");
    // The prorated first period defers a small shortfall, absorbed by one
    // extra period beyond the nominal 60 — never more than one, see
    // `projectDepreciationSchedule`'s doc comment.
    expect(schedule.length).toBe(61);
    expect(schedule.at(-1)!.netBookValueAfter).toBe("200.0000");
    expect(schedule.at(-1)!.accumulatedDepreciationAfter).toBe("6000.0000");
  });
});
