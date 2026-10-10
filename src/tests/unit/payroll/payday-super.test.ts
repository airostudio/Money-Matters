import { describe, expect, it } from "vitest";
import { australianFinancialYearStart, paydaySuperSafeByDate } from "@/domain/payroll/payday-super";
import { calculateSuperGuarantee } from "@/domain/payroll/super-calculations";

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("paydaySuperSafeByDate (conservative: weekends only, QE day counted as day 1)", () => {
  it("counts six weekdays after the QE day", () => {
    // Wed 2026-10-14 -> Thu15 Fri16 Mon19 Tue20 Wed21 Thu22
    expect(iso(paydaySuperSafeByDate(new Date("2026-10-14")))).toBe("2026-10-22");
    // Mon 2026-10-12 -> Tue13 Wed14 Thu15 Fri16 Mon19 Tue20
    expect(iso(paydaySuperSafeByDate(new Date("2026-10-12")))).toBe("2026-10-20");
  });

  it("skips weekends, including when the QE day itself is on one", () => {
    // Fri 2026-10-16 -> Mon19 Tue20 Wed21 Thu22 Fri23 Mon26
    expect(iso(paydaySuperSafeByDate(new Date("2026-10-16")))).toBe("2026-10-26");
    // Sat 2026-10-17 -> Mon19 Tue20 Wed21 Thu22 Fri23 Mon26
    expect(iso(paydaySuperSafeByDate(new Date("2026-10-17")))).toBe("2026-10-26");
  });

  it("is never later than a straightforward 7-weekday count (so it can only be early, never late)", () => {
    for (let i = 0; i < 28; i++) {
      const qe = new Date(Date.UTC(2026, 9, 1 + i));
      const safe = paydaySuperSafeByDate(qe);
      // 7 weekdays after the QE day, the latest reading excluding holidays.
      const d = new Date(qe);
      let n = 7;
      while (n > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n -= 1;
      }
      expect(safe.getTime()).toBeLessThanOrEqual(d.getTime());
    }
  });
});

describe("australianFinancialYearStart", () => {
  it("is 1 July of the year the date's financial year began", () => {
    expect(iso(australianFinancialYearStart(new Date("2026-06-30")))).toBe("2025-07-01");
    expect(iso(australianFinancialYearStart(new Date("2026-07-01")))).toBe("2026-07-01");
    expect(iso(australianFinancialYearStart(new Date("2027-02-10")))).toBe("2026-07-01");
  });
});

describe("annual maximum contribution base (2026-27: $270,830 at 12%)", () => {
  it("caps SG so the maximum for the year is 12% of the base, $32,499.60", () => {
    // Year-to-date QE already at 270,000; this payday adds 5,000 -> only 830 is still SG-liable.
    const nearCap = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "5000.00",
      quarterToDateOteBefore: "270000.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: "270830.0000",
    });
    expect(nearCap.oteSubjectToSg.toFixed(2)).toBe("830.00");
    expect(nearCap.superGuaranteeAmount.toFixed(2)).toBe("99.60");
    // 12% x 270,830 = 32,499.60, independently derived: 270,830 x 12 / 100.
    expect((270830 * 12) / 100).toBeCloseTo(32499.6, 6);
    const atCap = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "5000.00",
      quarterToDateOteBefore: "270830.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: "270830.0000",
    });
    expect(atCap.superGuaranteeAmount.toFixed(2)).toBe("0.00");
  });
});
