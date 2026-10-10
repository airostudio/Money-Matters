import { describe, expect, it } from "vitest";
import { ReportBuilderConfigSchema } from "@/domain/reporting/report-builder-service";

const VALID_BASE = {
  rowGroupBy: "ACCOUNT" as const,
  accountTypes: ["REVENUE", "EXPENSE"] as const,
  measure: "MOVEMENT" as const,
  periodBreakdown: "NONE" as const,
  dateFrom: "2026-01-01",
  dateTo: "2026-01-31",
};

/**
 * This is the exact config shape both the Report Builder UI and NL
 * reporting's `resolveNLReportRequest` must produce — validated through one
 * shared schema, see `report-builder-service.ts`'s doc comment.
 */
describe("ReportBuilderConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    expect(ReportBuilderConfigSchema.safeParse(VALID_BASE).success).toBe(true);
  });

  it("accepts an optional dimensionValueId, includeComparisonPeriod, includeZeroRows", () => {
    const result = ReportBuilderConfigSchema.safeParse({
      ...VALID_BASE,
      dimensionValueId: "11111111-1111-1111-1111-111111111111",
      includeComparisonPeriod: true,
      includeZeroRows: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty accountTypes array", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, accountTypes: [] }).success).toBe(false);
  });

  it("rejects an account type outside the fixed enum", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, accountTypes: ["REVENUE", "NOT_A_TYPE"] }).success).toBe(
      false,
    );
  });

  it("rejects an invalid rowGroupBy", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, rowGroupBy: "ACCOUNT_CATEGORY" }).success).toBe(false);
  });

  it("rejects an invalid measure", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, measure: "TOTAL" }).success).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, dateFrom: "01/01/2026" }).success).toBe(false);
  });

  it("rejects a non-uuid dimensionValueId", () => {
    expect(ReportBuilderConfigSchema.safeParse({ ...VALID_BASE, dimensionValueId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a config missing required fields", () => {
    const { dateTo: _dateTo, ...withoutDateTo } = VALID_BASE;
    expect(ReportBuilderConfigSchema.safeParse(withoutDateTo).success).toBe(false);
  });
});
