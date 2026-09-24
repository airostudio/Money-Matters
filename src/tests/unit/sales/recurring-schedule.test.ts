import { describe, expect, it } from "vitest";
import { advanceRecurringDate } from "@/domain/sales/recurring-schedule";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("advanceRecurringDate", () => {
  it("advances a WEEKLY schedule by exactly 7 days", () => {
    expect(iso(advanceRecurringDate(utcDate("2026-01-01"), "WEEKLY"))).toBe("2026-01-08");
  });

  it("advances a MONTHLY schedule by one calendar month, same day", () => {
    expect(iso(advanceRecurringDate(utcDate("2026-01-15"), "MONTHLY"))).toBe("2026-02-15");
  });

  it("advances a QUARTERLY schedule by three calendar months", () => {
    expect(iso(advanceRecurringDate(utcDate("2026-01-15"), "QUARTERLY"))).toBe("2026-04-15");
  });

  it("advances an ANNUALLY schedule by one calendar year, same day", () => {
    expect(iso(advanceRecurringDate(utcDate("2026-03-10"), "ANNUALLY"))).toBe("2027-03-10");
  });

  it("clamps a MONTHLY advance from the 31st into a shorter month", () => {
    // 31 Jan + 1 month -> Feb has 28 days in 2026 (not a leap year).
    expect(iso(advanceRecurringDate(utcDate("2026-01-31"), "MONTHLY"))).toBe("2026-02-28");
  });

  it("clamps an ANNUALLY advance from 29 Feb (leap year) into a non-leap year", () => {
    expect(iso(advanceRecurringDate(utcDate("2028-02-29"), "ANNUALLY"))).toBe("2029-02-28");
  });

  it("clamps a QUARTERLY advance across a shorter month", () => {
    // 30 Nov + 3 months -> Feb 2027 has 28 days.
    expect(iso(advanceRecurringDate(utcDate("2026-11-30"), "QUARTERLY"))).toBe("2027-02-28");
  });

  it("rolls a MONTHLY advance across a year boundary", () => {
    expect(iso(advanceRecurringDate(utcDate("2026-12-15"), "MONTHLY"))).toBe("2027-01-15");
  });

  it("running it repeatedly from a template's start date never regresses or skips a period for WEEKLY", () => {
    let date = utcDate("2026-01-01");
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      date = advanceRecurringDate(date, "WEEKLY");
      results.push(iso(date));
    }
    expect(results).toEqual(["2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29", "2026-02-05"]);
  });
});
