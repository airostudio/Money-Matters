import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { BracketCalculations, type TaxBracket } from "@/domain/payroll/bracket-calculations";

// FY2025-26 resident tax brackets — ato.gov.au, as verified for this slice.
const FY2025_26: TaxBracket[] = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.0000" },
  { sequence: 1, threshold: "18200.0000", marginalRate: "0.1600" },
  { sequence: 2, threshold: "45000.0000", marginalRate: "0.3000" },
  { sequence: 3, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 4, threshold: "190000.0000", marginalRate: "0.4500" },
];

// FY2026-27 — only the second bracket's rate changed, 16% -> 15%.
const FY2026_27: TaxBracket[] = [
  { sequence: 0, threshold: "0.0000", marginalRate: "0.0000" },
  { sequence: 1, threshold: "18200.0000", marginalRate: "0.1500" },
  { sequence: 2, threshold: "45000.0000", marginalRate: "0.3000" },
  { sequence: 3, threshold: "135000.0000", marginalRate: "0.3700" },
  { sequence: 4, threshold: "190000.0000", marginalRate: "0.4500" },
];

describe("BracketCalculations.cumulativeBaseAt — independent reproduction of the brief's hand-derived figures", () => {
  it("reproduces FY2026-27's $4,020 / $31,020 / $51,370 cumulative bases from nothing but the marginal rates/thresholds", () => {
    // Bracket 2 ($45,000 threshold): 15% of (45000-18200) = 0.15 * 26800 = 4020
    expect(BracketCalculations.cumulativeBaseAt(FY2026_27, 2).toFixed(2)).toBe("4020.00");
    // Bracket 3 ($135,000 threshold): 4020 + 30% of (135000-45000) = 4020 + 27000 = 31020
    expect(BracketCalculations.cumulativeBaseAt(FY2026_27, 3).toFixed(2)).toBe("31020.00");
    // Bracket 4 ($190,000 threshold): 31020 + 37% of (190000-135000) = 31020 + 20350 = 51370
    expect(BracketCalculations.cumulativeBaseAt(FY2026_27, 4).toFixed(2)).toBe("51370.00");
  });

  it("FY2025-26's bases differ only via the 16% (not 15%) second bracket", () => {
    // Bracket 2: 16% of 26800 = 4288
    expect(BracketCalculations.cumulativeBaseAt(FY2025_26, 2).toFixed(2)).toBe("4288.00");
    // Bracket 3: 4288 + 27000 = 31288
    expect(BracketCalculations.cumulativeBaseAt(FY2025_26, 3).toFixed(2)).toBe("31288.00");
    // Bracket 4: 31288 + 20350 = 51638
    expect(BracketCalculations.cumulativeBaseAt(FY2025_26, 4).toFixed(2)).toBe("51638.00");
  });
});

describe("BracketCalculations.annualTax", () => {
  it("is nil below the tax-free threshold", () => {
    expect(BracketCalculations.annualTax(FY2025_26, new Decimal(18200)).toFixed(2)).toBe("0.00");
    expect(BracketCalculations.annualTax(FY2025_26, new Decimal(10000)).toFixed(2)).toBe("0.00");
  });

  it("matches the ATO-style worked example at $45,000 for FY2026-27 (exactly the cumulative base, zero excess)", () => {
    expect(BracketCalculations.annualTax(FY2026_27, new Decimal(45000)).toFixed(2)).toBe("4020.00");
  });

  it("matches the ATO-style worked example at $135,000 for FY2026-27", () => {
    expect(BracketCalculations.annualTax(FY2026_27, new Decimal(135000)).toFixed(2)).toBe("31020.00");
  });

  it("computes tax on an income within the top bracket for FY2026-27", () => {
    // 51370 + 45% of (200000-190000) = 51370 + 4500 = 55870
    expect(BracketCalculations.annualTax(FY2026_27, new Decimal(200000)).toFixed(2)).toBe("55870.00");
  });

  it("computes tax on a mid-bracket income for FY2025-26", () => {
    // $80,000: 4288 + 30% of (80000-45000) = 4288 + 10500 = 14788
    expect(BracketCalculations.annualTax(FY2025_26, new Decimal(80000)).toFixed(2)).toBe("14788.00");
  });
});
