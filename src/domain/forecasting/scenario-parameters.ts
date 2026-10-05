import { z } from "zod";
import Decimal from "decimal.js";
import type { scenarioTypeEnum } from "@/db/schema";

export type ScenarioType = (typeof scenarioTypeEnum.enumValues)[number];

/**
 * The typed parameter set for each of the three scenario types master spec
 * §37 names — a closed set with explicit parameters, not a free-form
 * modeller. Every parameter that is an ASSUMPTION rather than a fact
 * (on-cost %, productivity ramp, case spreads, volume change, avoided-cost
 * %) is an explicit, user-editable input with a stated default; nothing is
 * hardcoded inside the calculation. Percentages and money are decimal
 * STRINGS (never JSON numbers/floats) and are parsed with decimal.js.
 *
 * These schemas run on every write (`ScenarioService.create/update`) AND on
 * every read of a saved scenario, so a malformed `parameters` blob can never
 * reach a calculation.
 */

const decimalRegex = /^-?\d+(\.\d+)?$/;

function decimalString(label: string) {
  return z.string({ required_error: `${label} is required.` }).trim().regex(decimalRegex, `${label} must be a decimal number such as "12.5".`);
}

/**
 * zod keeps running `.refine` after a failed `.regex`, so every refinement
 * guards on the same regex first — `new Decimal("lots")` would otherwise
 * throw a raw DecimalError out of `safeParse`.
 */
function test(v: string, predicate: (d: Decimal) => boolean): boolean {
  return decimalRegex.test(v) ? predicate(new Decimal(v)) : true; // a malformed value already failed the regex check
}

/** A decimal string within [min, max] inclusive. */
function boundedDecimal(label: string, min: number, max: number) {
  return decimalString(label).refine((v) => test(v, (d) => d.gte(min) && d.lte(max)), {
    message: `${label} must be between ${min} and ${max}.`,
  });
}

function positiveDecimal(label: string) {
  return decimalString(label).refine((v) => test(v, (d) => d.gt(0)), { message: `${label} must be greater than zero.` });
}

function nonNegativeDecimal(label: string) {
  return decimalString(label).refine((v) => test(v, (d) => d.gte(0)), { message: `${label} cannot be negative.` });
}

const isoDate = z
  .string({ required_error: "A date is required (YYYY-MM-DD)." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), {
    message: "That is not a real calendar date.",
  });

/**
 * Where the scenario's "unmodified baseline" monthly P&L comes from:
 * trailing actuals (the average of the last N FULL calendar months of posted
 * revenue and expense), or an ACTIVE baseline budget (Phase 9 Slice 1). Never
 * a silent default of an invented figure.
 */
export const BaselineSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("ACTUALS"), trailingMonths: z.number().int().min(1).max(12).default(3) }),
  z.object({ source: z.literal("BUDGET"), budgetId: z.string().uuid().optional() }),
]);
export type BaselineSource = z.infer<typeof BaselineSourceSchema>;

const DEFAULT_BASELINE: BaselineSource = { source: "ACTUALS", trailingMonths: 3 };

const nameField = z.string().trim().max(120).optional();

// ---------------------------------------------------------------------------
// HIRE_EMPLOYEE
// ---------------------------------------------------------------------------

export const HireEmployeeParamsSchema = z
  .object({
    roleTitle: nameField,
    annualSalary: positiveDecimal("Annual salary"),
    /**
     * Total on-costs as a % of salary (super + any other: payroll tax,
     * workers' compensation, leave loading). User-supplied. The UI PRE-FILLS
     * the verified Superannuation Guarantee rate from Phase 8's rule engine as
     * a suggested default, but it is just a suggestion the user can change —
     * no on-cost assumption is hardcoded here.
     */
    onCostPercent: boundedDecimal("On-cost %", 0, 100),
    startDate: isoDate,
    /** Expected incremental monthly revenue once fully productive; default "0" (a pure cost). */
    incrementalMonthlyRevenue: nonNegativeDecimal("Incremental monthly revenue").default("0"),
    /** Months for the revenue to ramp linearly from first month to full; 0 = full from the start. */
    rampMonths: z.number().int().min(0).max(24).default(0),
    /** Case spreads — percent of the stated expected revenue actually realised. */
    bestRevenuePercentOfExpected: boundedDecimal("Best-case revenue %", 100, 500).default("125"),
    worstRevenuePercentOfExpected: boundedDecimal("Worst-case revenue %", 0, 100).default("0"),
    baseline: BaselineSourceSchema.default(DEFAULT_BASELINE),
  })
  .strict();
export type HireEmployeeParams = z.infer<typeof HireEmployeeParamsSchema>;

// ---------------------------------------------------------------------------
// PRICE_CHANGE
// ---------------------------------------------------------------------------

export const PriceChangeScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL") }),
  z.object({ kind: z.literal("CUSTOMERS"), customerContactIds: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ kind: z.literal("PRODUCTS"), productIds: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ kind: z.literal("REVENUE_ACCOUNTS"), accountIds: z.array(z.string().uuid()).min(1).max(100) }),
]);
export type PriceChangeScope = z.infer<typeof PriceChangeScopeSchema>;

export const PriceChangeParamsSchema = z
  .object({
    /** Positive = increase, negative = decrease. */
    priceChangePercent: boundedDecimal("Price change %", -90, 500).refine((v) => test(v, (d) => !d.isZero()), {
      message: "A price change of 0% is not a scenario.",
    }),
    scope: PriceChangeScopeSchema.default({ kind: "ALL" }),
    effectiveDate: isoDate,
    /**
     * Volume change (% of units sold) the user assumes for each case, as a
     * result of the price change. Expected defaults to 0 — "no volume loss" —
     * deliberately: this slice does NOT estimate a price elasticity from
     * historical data (see docs/accounting-engine.md §14 for why), so the
     * assumption is explicit and the user's to set. Negative = volume lost.
     */
    volumeChangePercent: z
      .object({
        best: boundedDecimal("Best-case volume change %", -100, 100).default("0"),
        expected: boundedDecimal("Expected-case volume change %", -100, 100).default("0"),
        worst: boundedDecimal("Worst-case volume change %", -100, 100).default("-5"),
      })
      .strict()
      .default({}),
    /**
     * Share of revenue that is avoided cost when volume changes. Omit to use
     * the cost-of-sales ratio derived from this scope's own tracked-inventory
     * sales (0 if none exist) — the derived figure is shown in the result.
     */
    variableCostPercentOverride: boundedDecimal("Variable cost %", 0, 100).optional(),
    baseline: BaselineSourceSchema.default(DEFAULT_BASELINE),
  })
  .strict()
  .superRefine((p, ctx) => {
    const { best, expected, worst } = p.volumeChangePercent;
    if (![best, expected, worst].every((v) => decimalRegex.test(v))) return;
    if (!(new Decimal(best).gte(expected) && new Decimal(expected).gte(worst))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["volumeChangePercent"],
        message: "Volume assumptions must satisfy best ≥ expected ≥ worst.",
      });
    }
  });
export type PriceChangeParams = z.infer<typeof PriceChangeParamsSchema>;

// ---------------------------------------------------------------------------
// LOSE_CUSTOMER
// ---------------------------------------------------------------------------

export const LoseCustomerParamsSchema = z
  .object({
    /** Omit to default to the largest customer by trailing-12-month invoiced revenue (computed from real data). */
    customerContactId: z.string().uuid().optional(),
    effectiveDate: isoDate,
    /**
     * Share of the lost revenue that is avoided cost. Omit to use the cost of
     * sales actually attributable to this customer's tracked-inventory sales
     * (0 if none — in which case the margin effect equals the revenue effect
     * and the result says so).
     */
    avoidedCostPercentOverride: boundedDecimal("Avoided cost %", 0, 100).optional(),
    /** Best case: this % of the lost revenue is replaced by new business… */
    bestReplacementPercent: boundedDecimal("Best-case replacement %", 0, 100).default("50"),
    /** …starting this many months after the loss. */
    bestReplacementLagMonths: z.number().int().min(0).max(24).default(3),
    /** Worst case: the customer's currently open receivables are collected this many months late. */
    worstCollectionDelayMonths: z.number().int().min(0).max(12).default(2),
    baseline: BaselineSourceSchema.default(DEFAULT_BASELINE),
  })
  .strict();
export type LoseCustomerParams = z.infer<typeof LoseCustomerParamsSchema>;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type ScenarioParams =
  | { type: "HIRE_EMPLOYEE"; params: HireEmployeeParams }
  | { type: "PRICE_CHANGE"; params: PriceChangeParams }
  | { type: "LOSE_CUSTOMER"; params: LoseCustomerParams };

export const SCENARIO_PARAM_SCHEMAS = {
  HIRE_EMPLOYEE: HireEmployeeParamsSchema,
  PRICE_CHANGE: PriceChangeParamsSchema,
  LOSE_CUSTOMER: LoseCustomerParamsSchema,
} as const;

export const SCENARIO_TYPE_LABELS: Record<ScenarioType, string> = {
  HIRE_EMPLOYEE: "Hire an employee",
  PRICE_CHANGE: "Change prices",
  LOSE_CUSTOMER: "Lose a customer",
};

/**
 * Validates untrusted parameters (a form post, a stored JSON blob) against
 * the schema for `type`, returning the parsed, defaults-applied value or a
 * single readable error message. Never throws a raw ZodError at a caller.
 */
export function parseScenarioParams(
  type: ScenarioType,
  raw: unknown,
): { ok: true; value: ScenarioParams } | { ok: false; error: string } {
  const schema = SCENARIO_PARAM_SCHEMAS[type];
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return { ok: false, error: `${path}${first?.message ?? "Invalid scenario parameters."}` };
  }
  return { ok: true, value: { type, params: result.data } as ScenarioParams };
}
