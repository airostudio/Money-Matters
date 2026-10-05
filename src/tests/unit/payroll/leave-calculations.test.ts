import { describe, expect, it } from "vitest";
import { calculateLeaveAccrual } from "@/domain/payroll/leave-calculations";

describe("calculateLeaveAccrual — NES annual + personal leave", () => {
  it("accrues 1/52 of the full-time annual figures for a full-time weekly-paid SALARY employee", () => {
    const result = calculateLeaveAccrual({
      employmentBasis: "SALARY",
      payFrequency: "WEEKLY",
      standardHoursPerWeek: "38.00",
    });
    // 152 / 52 = 2.9230...
    expect(result.annualLeaveAccruedHours.toFixed(4)).toBe("2.9231");
    // 76 / 52 = 1.4615...
    expect(result.personalLeaveAccruedHours.toFixed(4)).toBe("1.4615");
  });

  it("pro-rates for a part-time SALARY employee (19 hours/week = 0.5 FTE)", () => {
    const result = calculateLeaveAccrual({
      employmentBasis: "SALARY",
      payFrequency: "FORTNIGHTLY",
      standardHoursPerWeek: "19.00",
    });
    // 152 * 0.5 / 26 = 2.9231; 76 * 0.5 / 26 = 1.4615
    expect(result.annualLeaveAccruedHours.toFixed(4)).toBe("2.9231");
    expect(result.personalLeaveAccruedHours.toFixed(4)).toBe("1.4615");
  });

  it("accrues proportionally to actual hours paid for an HOURLY employee", () => {
    // 38 hours paid out of a standard 38 * 52 = 1976 hour working year -> exactly 1/52 of the annual entitlement.
    const result = calculateLeaveAccrual({
      employmentBasis: "HOURLY",
      payFrequency: "WEEKLY",
      standardHoursPerWeek: "38.00",
      hoursPaidThisPeriod: "38.00",
    });
    expect(result.annualLeaveAccruedHours.toFixed(4)).toBe("2.9231");
    expect(result.personalLeaveAccruedHours.toFixed(4)).toBe("1.4615");
  });

  it("accrues less for an HOURLY employee who worked fewer hours than standard", () => {
    const fewer = calculateLeaveAccrual({
      employmentBasis: "HOURLY",
      payFrequency: "WEEKLY",
      standardHoursPerWeek: "38.00",
      hoursPaidThisPeriod: "19.00",
    });
    const full = calculateLeaveAccrual({
      employmentBasis: "HOURLY",
      payFrequency: "WEEKLY",
      standardHoursPerWeek: "38.00",
      hoursPaidThisPeriod: "38.00",
    });
    expect(fewer.annualLeaveAccruedHours.lessThan(full.annualLeaveAccruedHours)).toBe(true);
    // 19/38 of full hours -> half the accrual, modulo final rounding to 4dp on each side independently.
    expect(fewer.annualLeaveAccruedHours.toFixed(2)).toBe(full.annualLeaveAccruedHours.dividedBy(2).toFixed(2));
  });

  it("accrues zero leave for an HOURLY employee with zero hours this period", () => {
    const result = calculateLeaveAccrual({
      employmentBasis: "HOURLY",
      payFrequency: "WEEKLY",
      standardHoursPerWeek: "38.00",
      hoursPaidThisPeriod: "0",
    });
    expect(result.annualLeaveAccruedHours.toFixed(4)).toBe("0.0000");
    expect(result.personalLeaveAccruedHours.toFixed(4)).toBe("0.0000");
  });
});
