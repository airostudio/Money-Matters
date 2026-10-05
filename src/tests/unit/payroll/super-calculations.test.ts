import { describe, expect, it } from "vitest";
import { calculateSuperGuarantee, sgQuarterStart } from "@/domain/payroll/super-calculations";

describe("calculateSuperGuarantee — quarterly contribution base cap", () => {
  it("applies the full 12% rate when well below the quarterly cap", () => {
    const result = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "2000.00",
      quarterToDateOteBefore: "0.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: "62500.0000",
    });
    expect(result.oteSubjectToSg.toFixed(2)).toBe("2000.00");
    expect(result.superGuaranteeAmount.toFixed(2)).toBe("240.00");
    expect(result.quarterToDateOteAfter.toFixed(2)).toBe("2000.00");
  });

  it("caps SG exactly at the quarterly base — no SG on the portion above it", () => {
    // Already at 61,000 OTE this quarter; this period adds 3,000 -> 64,000, but
    // only 1,500 of it (62,500 - 61,000) is still SG-liable.
    const result = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "3000.00",
      quarterToDateOteBefore: "61000.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: "62500.0000",
    });
    expect(result.oteSubjectToSg.toFixed(2)).toBe("1500.00");
    expect(result.superGuaranteeAmount.toFixed(2)).toBe("180.00");
    expect(result.quarterToDateOteAfter.toFixed(2)).toBe("64000.00");
  });

  it("charges zero additional SG once the cap was already reached in a prior period this quarter", () => {
    const result = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "3000.00",
      quarterToDateOteBefore: "62500.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: "62500.0000",
    });
    expect(result.oteSubjectToSg.toFixed(2)).toBe("0.00");
    expect(result.superGuaranteeAmount.toFixed(2)).toBe("0.00");
    expect(result.quarterToDateOteAfter.toFixed(2)).toBe("65500.00");
  });

  it("applies the rate with no cap at all when quarterlyContributionBaseCap is null (unresolved rule set)", () => {
    const result = calculateSuperGuarantee({
      ordinaryTimeEarningsForPeriod: "100000.00",
      quarterToDateOteBefore: "0.00",
      sgRate: "0.1200",
      quarterlyContributionBaseCap: null,
    });
    expect(result.oteSubjectToSg.toFixed(2)).toBe("100000.00");
    expect(result.superGuaranteeAmount.toFixed(2)).toBe("12000.00");
  });
});

describe("sgQuarterStart", () => {
  it("buckets dates into the standard calendar quarters", () => {
    expect(sgQuarterStart(new Date("2026-01-15")).toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(sgQuarterStart(new Date("2026-03-31")).toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(sgQuarterStart(new Date("2026-04-01")).toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(sgQuarterStart(new Date("2026-10-05")).toISOString().slice(0, 10)).toBe("2026-10-01");
  });
});
