import type { ScenarioType } from "./scenario-parameters";

/**
 * Turns a browser form post into the raw (UNVALIDATED) parameter object for
 * a scenario type — strings stay decimal strings, blank optional fields are
 * left out so their documented defaults apply, and the only coercions are the
 * integer fields the zod schema declares as integers. All validation happens
 * in `parseScenarioParams` (via `ScenarioService.create/update/preview`); this
 * function never decides whether a value is acceptable.
 */

export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

function text(form: FormLike, name: string): string | undefined {
  const v = form.get(name);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function integer(form: FormLike, name: string): number | undefined {
  const s = text(form, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? (s as unknown as number) : n; // a non-numeric value is passed through so validation rejects it
}

function strip<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function baseline(form: FormLike) {
  if (text(form, "baselineSource") === "BUDGET") {
    return strip({ source: "BUDGET" as const, budgetId: text(form, "budgetId") });
  }
  return strip({ source: "ACTUALS" as const, trailingMonths: integer(form, "trailingMonths") });
}

export function scenarioParamsFromForm(type: ScenarioType, form: FormLike): Record<string, unknown> {
  switch (type) {
    case "HIRE_EMPLOYEE":
      return strip({
        roleTitle: text(form, "roleTitle"),
        annualSalary: text(form, "annualSalary"),
        onCostPercent: text(form, "onCostPercent"),
        startDate: text(form, "startDate"),
        incrementalMonthlyRevenue: text(form, "incrementalMonthlyRevenue"),
        rampMonths: integer(form, "rampMonths"),
        bestRevenuePercentOfExpected: text(form, "bestRevenuePercentOfExpected"),
        worstRevenuePercentOfExpected: text(form, "worstRevenuePercentOfExpected"),
        baseline: baseline(form),
      });
    case "PRICE_CHANGE": {
      const kind = text(form, "scopeKind") ?? "ALL";
      const ids = (name: string) => form.getAll(name).map(String).filter(Boolean);
      const scope =
        kind === "CUSTOMERS"
          ? { kind, customerContactIds: ids("customerContactIds") }
          : kind === "PRODUCTS"
            ? { kind, productIds: ids("productIds") }
            : kind === "REVENUE_ACCOUNTS"
              ? { kind, accountIds: ids("accountIds") }
              : { kind: "ALL" };
      return strip({
        priceChangePercent: text(form, "priceChangePercent"),
        scope,
        effectiveDate: text(form, "effectiveDate"),
        volumeChangePercent: strip({
          best: text(form, "volumeBest"),
          expected: text(form, "volumeExpected"),
          worst: text(form, "volumeWorst"),
        }),
        variableCostPercentOverride: text(form, "variableCostPercentOverride"),
        baseline: baseline(form),
      });
    }
    case "LOSE_CUSTOMER":
      return strip({
        customerContactId: text(form, "customerContactId"),
        effectiveDate: text(form, "effectiveDate"),
        avoidedCostPercentOverride: text(form, "avoidedCostPercentOverride"),
        bestReplacementPercent: text(form, "bestReplacementPercent"),
        bestReplacementLagMonths: integer(form, "bestReplacementLagMonths"),
        worstCollectionDelayMonths: integer(form, "worstCollectionDelayMonths"),
        baseline: baseline(form),
      });
  }
}

/** The inverse of `scenarioParamsFromForm`: flattens saved parameters back into the form's field names, for the edit page. */
export function formValuesFromParams(type: ScenarioType, params: unknown): Record<string, string | string[]> {
  const p = params as Record<string, unknown>;
  const out: Record<string, string | string[]> = {};
  const set = (name: string, v: unknown) => {
    if (v !== undefined && v !== null) out[name] = String(v);
  };
  const b = p.baseline as { source: string; trailingMonths?: number; budgetId?: string } | undefined;
  set("baselineSource", b?.source);
  set("trailingMonths", b?.trailingMonths);
  set("budgetId", b?.budgetId);

  if (type === "HIRE_EMPLOYEE") {
    for (const k of ["roleTitle", "annualSalary", "onCostPercent", "startDate", "incrementalMonthlyRevenue", "rampMonths", "bestRevenuePercentOfExpected", "worstRevenuePercentOfExpected"]) set(k, p[k]);
  } else if (type === "PRICE_CHANGE") {
    set("priceChangePercent", p.priceChangePercent);
    set("effectiveDate", p.effectiveDate);
    set("variableCostPercentOverride", p.variableCostPercentOverride);
    const v = p.volumeChangePercent as { best: string; expected: string; worst: string };
    set("volumeBest", v?.best);
    set("volumeExpected", v?.expected);
    set("volumeWorst", v?.worst);
    const scope = p.scope as { kind: string; customerContactIds?: string[]; productIds?: string[]; accountIds?: string[] };
    set("scopeKind", scope?.kind);
    if (scope?.customerContactIds) out.customerContactIds = scope.customerContactIds;
    if (scope?.productIds) out.productIds = scope.productIds;
    if (scope?.accountIds) out.accountIds = scope.accountIds;
  } else {
    for (const k of ["customerContactId", "effectiveDate", "avoidedCostPercentOverride", "bestReplacementPercent", "bestReplacementLagMonths", "worstCollectionDelayMonths"]) set(k, p[k]);
  }
  return out;
}
