import { describe, expect, it } from "vitest";
import { formValuesFromParams, scenarioParamsFromForm } from "@/domain/forecasting/scenario-form";
import { parseScenarioParams } from "@/domain/forecasting/scenario-parameters";

function form(entries: Array<[string, string]>) {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("scenario form <-> parameters", () => {
  it("HIRE_EMPLOYEE: blank optional fields are omitted so documented defaults apply; the result validates", () => {
    const raw = scenarioParamsFromForm(
      "HIRE_EMPLOYEE",
      form([
        ["annualSalary", "90000"],
        ["onCostPercent", "12"],
        ["startDate", "2026-11-01"],
        ["incrementalMonthlyRevenue", ""],
        ["rampMonths", ""],
        ["baselineSource", "ACTUALS"],
        ["trailingMonths", ""],
      ]),
    );
    expect(raw).not.toHaveProperty("incrementalMonthlyRevenue");
    expect(raw).not.toHaveProperty("rampMonths");
    const parsed = parseScenarioParams("HIRE_EMPLOYEE", raw);
    expect(parsed.ok).toBe(true);
  });

  it("a missing required field is surfaced by validation, not silently defaulted", () => {
    const raw = scenarioParamsFromForm("HIRE_EMPLOYEE", form([["annualSalary", "90000"], ["startDate", "2026-11-01"]]));
    const parsed = parseScenarioParams("HIRE_EMPLOYEE", raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.error).toContain("onCostPercent");
  });

  it("a non-numeric integer field is passed through so validation rejects it rather than coercing to NaN/0", () => {
    const raw = scenarioParamsFromForm(
      "HIRE_EMPLOYEE",
      form([["annualSalary", "90000"], ["onCostPercent", "12"], ["startDate", "2026-11-01"], ["rampMonths", "soon"]]),
    );
    expect(parseScenarioParams("HIRE_EMPLOYEE", raw).ok).toBe(false);
  });

  it("PRICE_CHANGE: builds the selected scope and volume spreads", () => {
    const raw = scenarioParamsFromForm(
      "PRICE_CHANGE",
      form([
        ["priceChangePercent", "8"],
        ["effectiveDate", "2026-11-01"],
        ["scopeKind", "CUSTOMERS"],
        ["customerContactIds", "11111111-1111-4111-8111-111111111111"],
        ["customerContactIds", "22222222-2222-4222-8222-222222222222"],
        ["volumeWorst", "-10"],
      ]),
    ) as { scope: { kind: string; customerContactIds: string[] }; volumeChangePercent: Record<string, string> };
    expect(raw.scope.kind).toBe("CUSTOMERS");
    expect(raw.scope.customerContactIds).toHaveLength(2);
    expect(raw.volumeChangePercent).toEqual({ worst: "-10" });
    const parsed = parseScenarioParams("PRICE_CHANGE", raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== "PRICE_CHANGE") throw new Error("expected ok");
    expect(parsed.value.params.volumeChangePercent).toEqual({ best: "0", expected: "0", worst: "-10" });
  });

  it("PRICE_CHANGE: a selected scope with nothing ticked is rejected", () => {
    const raw = scenarioParamsFromForm("PRICE_CHANGE", form([["priceChangePercent", "8"], ["effectiveDate", "2026-11-01"], ["scopeKind", "PRODUCTS"]]));
    expect(parseScenarioParams("PRICE_CHANGE", raw).ok).toBe(false);
  });

  it("LOSE_CUSTOMER: a blank customer means 'largest' (field omitted); a BUDGET baseline carries its budget id", () => {
    const raw = scenarioParamsFromForm(
      "LOSE_CUSTOMER",
      form([["customerContactId", ""], ["effectiveDate", "2026-12-01"], ["baselineSource", "BUDGET"], ["budgetId", "33333333-3333-4333-8333-333333333333"]]),
    );
    expect(raw).not.toHaveProperty("customerContactId");
    expect(raw.baseline).toEqual({ source: "BUDGET", budgetId: "33333333-3333-4333-8333-333333333333" });
    expect(parseScenarioParams("LOSE_CUSTOMER", raw).ok).toBe(true);
  });

  it("round-trips: saved parameters -> form values -> parameters is the identity", () => {
    const original = parseScenarioParams("PRICE_CHANGE", {
      priceChangePercent: "8",
      effectiveDate: "2026-11-01",
      scope: { kind: "REVENUE_ACCOUNTS", accountIds: ["44444444-4444-4444-8444-444444444444"] },
      volumeChangePercent: { best: "0", expected: "-1", worst: "-6" },
      variableCostPercentOverride: "30",
      baseline: { source: "ACTUALS", trailingMonths: 6 },
    });
    if (!original.ok) throw new Error("expected ok");
    const values = formValuesFromParams("PRICE_CHANGE", original.value.params);
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
    const again = parseScenarioParams("PRICE_CHANGE", scenarioParamsFromForm("PRICE_CHANGE", fd));
    expect(again.ok && again.value.params).toEqual(original.value.params);
  });
});
