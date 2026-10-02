import "server-only";
import { z } from "zod";
import type { DimensionWithValues } from "@/domain/dimensions/dimension-service";
import type { ReportBuilderConfig } from "./report-builder-service";
import {
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  formatDateParam,
  lastNMonths,
  lastNQuarters,
  previousMonthRange,
  previousQuarterRange,
  previousYearRange,
  type DateRange,
} from "./period-presets";

/**
 * Master spec §34, Natural-Language Reporting — quoted in full in
 * docs/ai-agents.md because it is this codebase's clearest statement of the
 * discipline every AI integration here follows:
 *
 * > "interpret question → generate a safe structured analytics request →
 * > query validated financial data → calculate result deterministically →
 * > render chart/table → explain. Never ask the LLM to calculate large
 * > financial datasets directly from text."
 *
 * This module is step one of that pipeline ONLY: turning a plain-English
 * question into an `NLReportRequest` — a small, closed-vocabulary structured
 * object (one of six metrics, one of nine period shapes, a breakdown, an
 * optional dimension reference) — never a number, never SQL, never free
 * text that gets executed. `resolveNLReportRequest` below is the
 * deterministic step that turns that request into the exact same
 * `ReportBuilderConfig` a human would get from the report builder's own
 * form, which `ReportBuilderService.runConfig` (completely unaware this
 * request originated from an AI call at all) then executes. The AI's
 * contribution ends at `NLReportRequest`; it never sees a balance, a total,
 * or any other computed figure, and it never produces one.
 */

export const NL_REPORT_METRICS = ["REVENUE", "EXPENSES", "NET_PROFIT", "ASSETS", "LIABILITIES", "EQUITY"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const NLReportPeriodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("THIS_MONTH") }),
  z.object({ kind: z.literal("LAST_MONTH") }),
  z.object({ kind: z.literal("THIS_QUARTER") }),
  z.object({ kind: z.literal("LAST_QUARTER") }),
  z.object({ kind: z.literal("THIS_YEAR") }),
  z.object({ kind: z.literal("LAST_YEAR") }),
  z.object({ kind: z.literal("LAST_N_MONTHS"), n: z.number().int().min(1).max(36) }),
  z.object({ kind: z.literal("LAST_N_QUARTERS"), n: z.number().int().min(1).max(12) }),
  z.object({ kind: z.literal("CUSTOM"), from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) }),
]);

/**
 * The ENTIRE output the AI (or a human testing the pipeline) is allowed to
 * produce. `dimensionKey`/`dimensionValue` are free strings — unlike
 * `metric`/`period.kind`, there's no fixed enum of dimension names an
 * organization might define — but see `resolveNLReportRequest`: neither is
 * ever trusted as an id. Both are matched, case-insensitively, against the
 * organization's *actual* dimensions/values (handed to the AI in its prompt
 * context, never its balances — see `NLReportingService.interpret`), and a
 * string that doesn't match a real one is a hard failure, not a guess. This
 * is the same discipline docs/ai-agents.md §0a applies to fuzzy
 * reconciliation's candidate ids: never trust a reference the model merely
 * claims, only one that was actually in the list it was given.
 */
export const NLReportRequestSchema = z.object({
  metric: z.enum(NL_REPORT_METRICS),
  period: NLReportPeriodSchema,
  breakdown: z.enum(["NONE", "MONTHLY", "QUARTERLY"]),
  dimensionKey: z.string().min(1).max(200).optional(),
  dimensionValue: z.string().min(1).max(200).optional(),
  compareToPriorPeriod: z.boolean().optional(),
});

export type NLReportRequest = z.infer<typeof NLReportRequestSchema>;

function resolvePeriod(period: NLReportRequest["period"], today: Date): DateRange {
  switch (period.kind) {
    case "THIS_MONTH":
      return currentMonthRange(today);
    case "LAST_MONTH":
      return previousMonthRange(currentMonthRange(today));
    case "THIS_QUARTER":
      return currentQuarterRange(today);
    case "LAST_QUARTER":
      return previousQuarterRange(currentQuarterRange(today));
    case "THIS_YEAR":
      return currentYearRange(today);
    case "LAST_YEAR":
      return previousYearRange(currentYearRange(today));
    case "LAST_N_MONTHS":
      return lastNMonths(period.n, today);
    case "LAST_N_QUARTERS":
      return lastNQuarters(period.n, today);
    case "CUSTOM": {
      const [fy, fm, fd] = period.from.split("-").map(Number);
      const [ty, tm, td] = period.to.split("-").map(Number);
      return { from: new Date(Date.UTC(fy!, fm! - 1, fd!)), to: new Date(Date.UTC(ty!, tm! - 1, td!)) };
    }
  }
}

function periodLabel(period: NLReportRequest["period"], range: DateRange): string {
  switch (period.kind) {
    case "THIS_MONTH":
      return "this month";
    case "LAST_MONTH":
      return "last month";
    case "THIS_QUARTER":
      return "this quarter";
    case "LAST_QUARTER":
      return "last quarter";
    case "THIS_YEAR":
      return "this year";
    case "LAST_YEAR":
      return "last year";
    case "LAST_N_MONTHS":
      return `the last ${period.n} months`;
    case "LAST_N_QUARTERS":
      return `the last ${period.n} quarters`;
    case "CUSTOM":
      return `${formatDateParam(range.from)} – ${formatDateParam(range.to)}`;
  }
}

const METRIC_CONFIG: Record<
  (typeof NL_REPORT_METRICS)[number],
  { accountTypes: ReportBuilderConfig["accountTypes"]; measure: ReportBuilderConfig["measure"]; label: string }
> = {
  REVENUE: { accountTypes: ["REVENUE"], measure: "MOVEMENT", label: "Revenue" },
  EXPENSES: { accountTypes: ["EXPENSE"], measure: "MOVEMENT", label: "Expenses" },
  NET_PROFIT: { accountTypes: ["REVENUE", "EXPENSE"], measure: "MOVEMENT", label: "Net Profit (Revenue and Expenses)" },
  ASSETS: { accountTypes: ["ASSET"], measure: "BALANCE", label: "Assets" },
  LIABILITIES: { accountTypes: ["LIABILITY"], measure: "BALANCE", label: "Liabilities" },
  EQUITY: { accountTypes: ["EQUITY"], measure: "BALANCE", label: "Equity" },
};

export interface ResolvedNLReport {
  config: ReportBuilderConfig;
  /** A one-line plain-English restatement of what was computed, shown above the result so the user can verify the system understood them before trusting the numbers (master spec §34). */
  restatement: string;
}

export interface NLReportResolutionError {
  error: string;
}

/**
 * The deterministic step of the pipeline: turns an already-validated
 * `NLReportRequest` into a `ReportBuilderConfig`, resolving relative period
 * language against `today` and matching `dimensionKey`/`dimensionValue`
 * against the organization's real dimensions — never against the model's
 * own say-so. Returns `{ error }` (never throws) when a dimension reference
 * doesn't match anything real, so the caller can ask the user to rephrase
 * rather than silently dropping the filter or guessing which dimension was
 * meant.
 */
export function resolveNLReportRequest(
  request: NLReportRequest,
  context: { today?: Date; dimensions: DimensionWithValues[] },
): ResolvedNLReport | NLReportResolutionError {
  const today = context.today ?? new Date();
  const metricConfig = METRIC_CONFIG[request.metric];
  const range = resolvePeriod(request.period, today);

  let dimensionValueId: string | undefined;
  let dimensionLabel: string | undefined;
  if (request.dimensionKey) {
    const dimension = context.dimensions.find(
      (d) =>
        d.key.toLowerCase() === request.dimensionKey!.toLowerCase() ||
        d.name.toLowerCase() === request.dimensionKey!.toLowerCase(),
    );
    if (!dimension) {
      return { error: `I couldn't find a dimension called "${request.dimensionKey}" in this organization.` };
    }
    if (!request.dimensionValue) {
      return { error: `Which ${dimension.name.toLowerCase()} did you mean? Please include a specific value.` };
    }
    const value = dimension.values.find(
      (v) =>
        v.value.toLowerCase() === request.dimensionValue!.toLowerCase() ||
        v.label.toLowerCase() === request.dimensionValue!.toLowerCase(),
    );
    if (!value) {
      return {
        error: `I couldn't find "${request.dimensionValue}" as a value of ${dimension.name} in this organization.`,
      };
    }
    dimensionValueId = value.id;
    dimensionLabel = `${dimension.name}: ${value.label}`;
  } else if (request.dimensionValue) {
    return { error: "I understood a dimension value but not which dimension it belongs to — please be more specific." };
  }

  const config: ReportBuilderConfig = {
    rowGroupBy: "ACCOUNT_TYPE",
    accountTypes: metricConfig.accountTypes,
    measure: metricConfig.measure,
    periodBreakdown: request.breakdown,
    dateFrom: formatDateParam(range.from),
    dateTo: formatDateParam(range.to),
    dimensionValueId,
    includeComparisonPeriod: request.compareToPriorPeriod,
  };

  const breakdownLabel =
    request.breakdown === "MONTHLY" ? "by month" : request.breakdown === "QUARTERLY" ? "by quarter" : undefined;
  const parts = [
    `Showing: ${metricConfig.label}`,
    breakdownLabel,
    `for ${periodLabel(request.period, range)}`,
    dimensionLabel ? `filtered to ${dimensionLabel}` : undefined,
    request.compareToPriorPeriod ? "compared to the prior equivalent period" : undefined,
  ].filter(Boolean);

  return { config, restatement: parts.join(", ") };
}
