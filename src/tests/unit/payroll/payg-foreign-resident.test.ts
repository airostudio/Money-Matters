import { describe, expect, it } from "vitest";
import { ForeignResidentRatesMissingError, calculatePaygWithholding } from "@/domain/payroll/payg-calculations";

const resident = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.0000" },
  { sequence: 1, threshold: "18200.0000", marginalRate: "0.1500" },
  { sequence: 2, threshold: "45000.0000", marginalRate: "0.3000" },
  { sequence: 3, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 4, threshold: "190000.0000", marginalRate: "0.4500" },
];
// Foreign resident annual rates (ATO "About foreign resident tax rates"; ozcalc.com.au; austax.tools; taxbne.com.au):
// 30% from the first dollar to $135,000, 37% to $190,000, 45% above; no Medicare levy.
const foreign = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.3000" },
  { sequence: 1, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 2, threshold: "190000.0000", marginalRate: "0.4500" },
];
const base = {
  payFrequency: "FORTNIGHTLY" as const,
  taxFreeThresholdClaimed: true,
  brackets: resident,
  medicareLevy: { rate: "0.0200", lowerThreshold: "28011.0000", upperThreshold: "35013.0000" },
};

describe("foreign resident withholding (annualised-bracket approximation; no tax-free threshold, no Medicare levy)", () => {
  it("4,000 a fortnight: 104,000 x 30% = 31,200 / 26 = 1,200.0000 exactly", () => {
    const w = calculatePaygWithholding({ ...base, grossPayForPeriod: "4000", residency: "FOREIGN_RESIDENT", foreignResidentBrackets: foreign });
    expect(w.toFixed(4)).toBe("1200.0000");
  });

  it("6,000 a fortnight crosses the 37% bracket: (40,500 + 21,000 x 37% = 48,270) / 26 = 1,856.5385", () => {
    const w = calculatePaygWithholding({ ...base, grossPayForPeriod: "6000", residency: "FOREIGN_RESIDENT", foreignResidentBrackets: foreign });
    expect(w.toFixed(4)).toBe("1856.5385");
  });

  it("ignores a claimed tax-free threshold (a foreign resident has none) and differs from the resident figure", () => {
    const fr = calculatePaygWithholding({ ...base, grossPayForPeriod: "4000", taxFreeThresholdClaimed: true, residency: "FOREIGN_RESIDENT", foreignResidentBrackets: foreign });
    const res = calculatePaygWithholding({ ...base, grossPayForPeriod: "4000" });
    expect(res.toFixed(4)).toBe("915.3846");
    expect(fr.greaterThan(res)).toBe(true);
  });

  it("refuses rather than falling back to resident rates when no foreign resident rates are available", () => {
    expect(() => calculatePaygWithholding({ ...base, grossPayForPeriod: "4000", residency: "FOREIGN_RESIDENT" })).toThrow(ForeignResidentRatesMissingError);
    expect(() => calculatePaygWithholding({ ...base, grossPayForPeriod: "4000", residency: "FOREIGN_RESIDENT", foreignResidentBrackets: [] })).toThrow(ForeignResidentRatesMissingError);
  });
});

describe("Medicare levy shade-in (verified 10c per dollar over the lower threshold, capped at 2%)", () => {
  it("withholds the shade-in amount between the 2025-26 singles thresholds", () => {
    // 30,000 a year, paid weekly: 577.0833.../week is not needed; use an annual 30,000 via 26 x 1153.8462 is lossy.
    // Use monthly 2,500 -> exactly 30,000 a year: income tax (30,000 - 18,200) x 15% = 1,770; levy 10% x (30,000 - 28,011) = 198.90.
    const w = calculatePaygWithholding({ ...base, grossPayForPeriod: "2500", payFrequency: "MONTHLY" });
    expect(w.toFixed(4)).toBe(((1770 + 198.9) / 12).toFixed(4)); // 164.0750
  });
});
