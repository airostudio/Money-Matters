import { z } from "zod";
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
} from "@/domain/reporting/period-presets";

/**
 * The same small, closed-vocabulary period shape as
 * `src/domain/reporting/nl-report-query.ts`'s `NLReportPeriodSchema` —
 * duplicated rather than imported because that module's schema is paired
 * tightly with `NLReportRequestSchema`'s single-metric shape, while the
 * Financial Controller's tools need a period argument independent of any
 * particular tool. Both build on the exact same `period-presets.ts`
 * primitives, so "last quarter" always means the same calendar range
 * everywhere in this codebase.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PeriodArgSchema = z.discriminatedUnion("kind", [
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

export type PeriodArg = z.infer<typeof PeriodArgSchema>;

export function resolvePeriodArg(period: PeriodArg, today: Date = new Date()): DateRange {
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

export function periodArgLabel(period: PeriodArg, range: DateRange): string {
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
