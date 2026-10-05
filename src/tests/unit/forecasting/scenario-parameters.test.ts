import { describe, expect, it } from "vitest";
import { parseScenarioParams } from "@/domain/forecasting/scenario-parameters";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

describe("scenario parameter validation (zod, per type)", () => {
  describe("HIRE_EMPLOYEE", () => {
    const valid = { annualSalary: "120000", onCostPercent: "12", startDate: "2026-11-16" };

    it("accepts a minimal set and applies the documented defaults", () => {
      const r = parseScenarioParams("HIRE_EMPLOYEE", valid);
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.type !== "HIRE_EMPLOYEE") throw new Error("expected ok");
      expect(r.value.params.incrementalMonthlyRevenue).toBe("0");
      expect(r.value.params.rampMonths).toBe(0);
      expect(r.value.params.bestRevenuePercentOfExpected).toBe("125");
      expect(r.value.params.worstRevenuePercentOfExpected).toBe("0");
      expect(r.value.params.baseline).toEqual({ source: "ACTUALS", trailingMonths: 3 });
    });

    it.each([
      ["missing salary", { onCostPercent: "12", startDate: "2026-11-16" }],
      ["missing on-cost (no hardcoded AU on-cost)", { annualSalary: "120000", startDate: "2026-11-16" }],
      ["missing start date", { annualSalary: "120000", onCostPercent: "12" }],
      ["zero salary", { ...valid, annualSalary: "0" }],
      ["negative salary", { ...valid, annualSalary: "-5" }],
      ["non-numeric salary", { ...valid, annualSalary: "lots" }],
      ["a JSON number instead of a decimal string", { ...valid, annualSalary: 120000 }],
      ["on-cost over 100%", { ...valid, onCostPercent: "101" }],
      ["negative on-cost", { ...valid, onCostPercent: "-1" }],
      ["malformed date", { ...valid, startDate: "16/11/2026" }],
      ["impossible date", { ...valid, startDate: "2026-02-30" }],
      ["negative incremental revenue", { ...valid, incrementalMonthlyRevenue: "-1" }],
      ["best-case below 100%", { ...valid, bestRevenuePercentOfExpected: "90" }],
      ["worst-case above 100%", { ...valid, worstRevenuePercentOfExpected: "110" }],
      ["unknown extra parameter", { ...valid, hiddenBonus: "1" }],
      ["fractional ramp months", { ...valid, rampMonths: 1.5 }],
    ])("rejects %s", (_label, input) => {
      expect(parseScenarioParams("HIRE_EMPLOYEE", input).ok).toBe(false);
    });
  });

  describe("PRICE_CHANGE", () => {
    const valid = { priceChangePercent: "8", effectiveDate: "2026-11-01" };

    it("accepts a minimal set: scope ALL, no volume loss expected, documented worst-case spread", () => {
      const r = parseScenarioParams("PRICE_CHANGE", valid);
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.type !== "PRICE_CHANGE") throw new Error("expected ok");
      expect(r.value.params.scope).toEqual({ kind: "ALL" });
      expect(r.value.params.volumeChangePercent).toEqual({ best: "0", expected: "0", worst: "-5" });
    });

    it("accepts a price DECREASE and a customer-scoped change", () => {
      expect(parseScenarioParams("PRICE_CHANGE", { ...valid, priceChangePercent: "-3.5" }).ok).toBe(true);
      expect(parseScenarioParams("PRICE_CHANGE", { ...valid, scope: { kind: "CUSTOMERS", customerContactIds: [CUSTOMER_ID] } }).ok).toBe(true);
    });

    it.each([
      ["missing price change", { effectiveDate: "2026-11-01" }],
      ["zero price change", { ...valid, priceChangePercent: "0" }],
      ["price cut of 100%+", { ...valid, priceChangePercent: "-100" }],
      ["missing effective date", { priceChangePercent: "8" }],
      ["empty customer scope", { ...valid, scope: { kind: "CUSTOMERS", customerContactIds: [] } }],
      ["non-uuid customer id", { ...valid, scope: { kind: "CUSTOMERS", customerContactIds: ["abc"] } }],
      ["unknown scope kind", { ...valid, scope: { kind: "EVERYTHING" } }],
      ["volume spreads out of order (best < worst)", { ...valid, volumeChangePercent: { best: "-10", expected: "0", worst: "0" } }],
      ["variable cost over 100%", { ...valid, variableCostPercentOverride: "150" }],
    ])("rejects %s", (_label, input) => {
      expect(parseScenarioParams("PRICE_CHANGE", input).ok).toBe(false);
    });
  });

  describe("LOSE_CUSTOMER", () => {
    const valid = { effectiveDate: "2026-12-01" };

    it("accepts just an effective date — the customer defaults to the largest at run time", () => {
      const r = parseScenarioParams("LOSE_CUSTOMER", valid);
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.type !== "LOSE_CUSTOMER") throw new Error("expected ok");
      expect(r.value.params.customerContactId).toBeUndefined();
      expect(r.value.params.bestReplacementPercent).toBe("50");
      expect(r.value.params.bestReplacementLagMonths).toBe(3);
      expect(r.value.params.worstCollectionDelayMonths).toBe(2);
    });

    it.each([
      ["missing effective date", {}],
      ["non-uuid customer", { ...valid, customerContactId: "nope" }],
      ["replacement over 100%", { ...valid, bestReplacementPercent: "120" }],
      ["negative collection delay", { ...valid, worstCollectionDelayMonths: -1 }],
      ["avoided cost over 100%", { ...valid, avoidedCostPercentOverride: "101" }],
      ["a baseline of an unknown source", { ...valid, baseline: { source: "VIBES" } }],
    ])("rejects %s", (_label, input) => {
      expect(parseScenarioParams("LOSE_CUSTOMER", input).ok).toBe(false);
    });

    it("accepts a budget baseline", () => {
      expect(parseScenarioParams("LOSE_CUSTOMER", { ...valid, baseline: { source: "BUDGET" } }).ok).toBe(true);
    });
  });

  it("returns a single readable error naming the offending field, never a raw ZodError", () => {
    const r = parseScenarioParams("HIRE_EMPLOYEE", { annualSalary: "-5", onCostPercent: "12", startDate: "2026-11-16" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("annualSalary");
  });

  it("rejects null / non-object input for every type", () => {
    for (const type of ["HIRE_EMPLOYEE", "PRICE_CHANGE", "LOSE_CUSTOMER"] as const) {
      expect(parseScenarioParams(type, null).ok).toBe(false);
      expect(parseScenarioParams(type, "x").ok).toBe(false);
    }
  });
});
