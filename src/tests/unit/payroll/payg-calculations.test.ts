import { describe, expect, it } from "vitest";
import {
  annualMedicareLevy,
  calculatePaygWithholding,
  withoutTaxFreeThreshold,
  type MedicareLevyRule,
} from "@/domain/payroll/payg-calculations";
import type { TaxBracket } from "@/domain/payroll/bracket-calculations";
import Decimal from "decimal.js";

const FY2025_26: TaxBracket[] = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.0000" },
  { sequence: 1, threshold: "18200.0000", marginalRate: "0.1600" },
  { sequence: 2, threshold: "45000.0000", marginalRate: "0.3000" },
  { sequence: 3, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 4, threshold: "190000.0000", marginalRate: "0.4500" },
];

const FY2026_27: TaxBracket[] = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.0000" },
  { sequence: 1, threshold: "18200.0000", marginalRate: "0.1500" },
  { sequence: 2, threshold: "45000.0000", marginalRate: "0.3000" },
  { sequence: 3, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 4, threshold: "190000.0000", marginalRate: "0.4500" },
];

const MEDICARE: MedicareLevyRule = { rate: "0.0200", lowerThreshold: "28011.0000", upperThreshold: "35013.0000" };

describe("Medicare levy low-income step function", () => {
  it("is nil below the lower threshold", () => {
    expect(annualMedicareLevy(MEDICARE, new Decimal(20000)).toFixed(2)).toBe("0.00");
  });

  it("is the full standard rate at/above the upper threshold", () => {
    expect(annualMedicareLevy(MEDICARE, new Decimal(100000)).toFixed(2)).toBe("2000.00");
    expect(annualMedicareLevy(MEDICARE, new Decimal(35013)).toFixed(2)).toBe("700.26");
  });

  it("phases in linearly between the two thresholds, capped at the standard amount", () => {
    // (30000 - 28011) * 0.10 = 198.90, vs full levy 30000*0.02=600 -> min is 198.90
    expect(annualMedicareLevy(MEDICARE, new Decimal(30000)).toFixed(2)).toBe("198.90");
  });
});

describe("calculatePaygWithholding — annualized-bracket method", () => {
  it("withholds $0 for a gross pay that annualizes below the tax-free threshold (weekly)", () => {
    const result = calculatePaygWithholding({
      grossPayForPeriod: "300.00", // 300 * 52 = 15,600 < 18,200
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    expect(result.toFixed(2)).toBe("0.00");
  });

  it("hand-computed weekly example at $1,500/week gross, threshold claimed, FY2025-26", () => {
    // Annualized: 1500 * 52 = 78,000
    // Income tax: 4,288 + 30% * (78,000 - 45,000) = 4,288 + 9,900 = 14,188
    // Medicare: 78,000 >= 35,013 upper threshold -> full 2% = 1,560
    // Annual withholding: 15,748 ; weekly: 15,748 / 52 = 302.8461538...
    const result = calculatePaygWithholding({
      grossPayForPeriod: "1500.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    expect(result.toFixed(2)).toBe("302.85");
  });

  it("the same $1,500/week gross withholds LESS in FY2026-27 than FY2025-26 (the tax cut actually reduces withholding)", () => {
    const fy2526 = calculatePaygWithholding({
      grossPayForPeriod: "1500.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    const fy2627 = calculatePaygWithholding({
      grossPayForPeriod: "1500.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2026_27,
      medicareLevy: MEDICARE,
    });
    expect(fy2627.lessThan(fy2526)).toBe(true);
    // Annualized 78,000: income tax = 4,020 + 30%*(78000-45000) = 4,020+9,900=13,920; + medicare 1,560 = 15,480; /52 = 297.6923...
    expect(fy2627.toFixed(2)).toBe("297.69");
  });

  it("hand-computed fortnightly example at $3,000/fortnight gross, threshold claimed, FY2026-27", () => {
    // Annualized: 3000 * 26 = 78,000 -> same annual figures as above: 13,920 + 1,560 = 15,480
    // Fortnightly: 15,480 / 26 = 595.3846...
    const result = calculatePaygWithholding({
      grossPayForPeriod: "3000.00",
      payFrequency: "FORTNIGHTLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2026_27,
      medicareLevy: MEDICARE,
    });
    expect(result.toFixed(2)).toBe("595.38");
  });

  it("withholds more when the tax-free threshold is NOT claimed, for the same gross pay", () => {
    const claimed = calculatePaygWithholding({
      grossPayForPeriod: "800.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    const notClaimed = calculatePaygWithholding({
      grossPayForPeriod: "800.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: false,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    expect(notClaimed.greaterThan(claimed)).toBe(true);
  });

  it("never withholds more than gross pay, even for a pathological input", () => {
    const result = calculatePaygWithholding({
      grossPayForPeriod: "1.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: false,
      brackets: FY2025_26,
      medicareLevy: MEDICARE,
    });
    expect(result.lessThanOrEqualTo(1)).toBe(true);
  });
});

describe("withoutTaxFreeThreshold", () => {
  it("removes the nil band and pulls the next bracket's threshold to $0", () => {
    const adjusted = withoutTaxFreeThreshold(FY2025_26);
    expect(adjusted[0]).toEqual({ sequence: 0, threshold: "0.0000", marginalRate: "0.1600" });
  });
});
