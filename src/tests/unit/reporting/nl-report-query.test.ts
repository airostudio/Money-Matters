import { describe, expect, it } from "vitest";
import { NLReportRequestSchema, resolveNLReportRequest } from "@/domain/reporting/nl-report-query";
import type { DimensionWithValues } from "@/domain/dimensions/dimension-service";

const TODAY = new Date(Date.UTC(2026, 5, 15)); // June 15, 2026

const PROJECT_DIMENSION: DimensionWithValues = {
  id: "dim-1",
  key: "project",
  name: "Project",
  isActive: true,
  values: [
    { id: "val-1", value: "website_rebuild", label: "Website Rebuild", isActive: true },
    { id: "val-2", value: "mobile_app", label: "Mobile App", isActive: true },
  ],
};

describe("NLReportRequestSchema — rejects malformed/hallucinated AI output", () => {
  it("accepts a well-formed request", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "LAST_MONTH" },
      breakdown: "NONE",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a metric outside the fixed enum (a hallucinated metric)", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "PROFIT_MARGIN_RATIO",
      period: { kind: "LAST_MONTH" },
      breakdown: "NONE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a period kind outside the fixed enum", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "NEXT_FORTNIGHT" },
      breakdown: "NONE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects LAST_N_MONTHS with no n", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "LAST_N_MONTHS" },
      breakdown: "NONE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects LAST_N_MONTHS with n out of range", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "LAST_N_MONTHS", n: 999 },
      breakdown: "NONE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CUSTOM with a malformed date", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "CUSTOM", from: "last-tuesday", to: "2026-06-15" },
      breakdown: "NONE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown breakdown value", () => {
    const result = NLReportRequestSchema.safeParse({
      metric: "REVENUE",
      period: { kind: "THIS_MONTH" },
      breakdown: "WEEKLY",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing metric entirely", () => {
    const result = NLReportRequestSchema.safeParse({ period: { kind: "THIS_MONTH" }, breakdown: "NONE" });
    expect(result.success).toBe(false);
  });
});

describe("resolveNLReportRequest — deterministic resolution into a ReportBuilderConfig", () => {
  it("resolves REVENUE/THIS_MONTH into a MOVEMENT config over the current calendar month", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "THIS_MONTH" }, breakdown: "NONE" },
      { today: TODAY, dimensions: [] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.accountTypes).toEqual(["REVENUE"]);
    expect(resolved.config.measure).toBe("MOVEMENT");
    expect(resolved.config.dateFrom).toBe("2026-06-01");
    expect(resolved.config.dateTo).toBe("2026-06-30");
    expect(resolved.restatement).toContain("Revenue");
  });

  it("resolves ASSETS into a BALANCE config (a balance is as-of, not a movement)", () => {
    const resolved = resolveNLReportRequest(
      { metric: "ASSETS", period: { kind: "THIS_YEAR" }, breakdown: "NONE" },
      { today: TODAY, dimensions: [] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.accountTypes).toEqual(["ASSET"]);
    expect(resolved.config.measure).toBe("BALANCE");
  });

  it("resolves LAST_N_MONTHS with a monthly breakdown", () => {
    const resolved = resolveNLReportRequest(
      { metric: "EXPENSES", period: { kind: "LAST_N_MONTHS", n: 3 }, breakdown: "MONTHLY" },
      { today: TODAY, dimensions: [] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.periodBreakdown).toBe("MONTHLY");
    expect(resolved.config.dateFrom).toBe("2026-04-01");
    expect(resolved.config.dateTo).toBe("2026-06-30");
  });

  it("resolves compareToPriorPeriod into includeComparisonPeriod", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "THIS_QUARTER" }, breakdown: "NONE", compareToPriorPeriod: true },
      { today: TODAY, dimensions: [] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.includeComparisonPeriod).toBe(true);
    expect(resolved.restatement).toContain("compared to the prior equivalent period");
  });

  it("matches a dimension key/value case-insensitively against the organization's real dimensions", () => {
    const resolved = resolveNLReportRequest(
      {
        metric: "REVENUE",
        period: { kind: "THIS_MONTH" },
        breakdown: "NONE",
        dimensionKey: "project",
        dimensionValue: "website rebuild",
      },
      { today: TODAY, dimensions: [PROJECT_DIMENSION] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.dimensionValueId).toBe("val-1");
    expect(resolved.restatement).toContain("Project: Website Rebuild");
  });

  it("rejects (never guesses) a dimensionKey that doesn't match any real dimension", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "THIS_MONTH" }, breakdown: "NONE", dimensionKey: "Department" },
      { today: TODAY, dimensions: [PROJECT_DIMENSION] },
    );
    expect("error" in resolved).toBe(true);
  });

  it("rejects (never guesses) a dimensionValue that doesn't match any real value of that dimension", () => {
    const resolved = resolveNLReportRequest(
      {
        metric: "REVENUE",
        period: { kind: "THIS_MONTH" },
        breakdown: "NONE",
        dimensionKey: "Project",
        dimensionValue: "Nonexistent Project",
      },
      { today: TODAY, dimensions: [PROJECT_DIMENSION] },
    );
    expect("error" in resolved).toBe(true);
  });

  it("rejects a dimensionValue given with no dimensionKey", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "THIS_MONTH" }, breakdown: "NONE", dimensionValue: "Website Rebuild" },
      { today: TODAY, dimensions: [PROJECT_DIMENSION] },
    );
    expect("error" in resolved).toBe(true);
  });

  it("asks for clarification when a dimensionKey is given with no value", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "THIS_MONTH" }, breakdown: "NONE", dimensionKey: "Project" },
      { today: TODAY, dimensions: [PROJECT_DIMENSION] },
    );
    expect("error" in resolved).toBe(true);
  });

  it("resolves a CUSTOM period using the exact dates given", () => {
    const resolved = resolveNLReportRequest(
      { metric: "REVENUE", period: { kind: "CUSTOM", from: "2025-01-01", to: "2025-03-31" }, breakdown: "NONE" },
      { today: TODAY, dimensions: [] },
    );
    if ("error" in resolved) throw new Error("expected success");
    expect(resolved.config.dateFrom).toBe("2025-01-01");
    expect(resolved.config.dateTo).toBe("2025-03-31");
  });
});
