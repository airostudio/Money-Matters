/**
 * Pure date-range helpers for the financial statement pages' default
 * periods and comparison-period picker. Kept here (not inline in the page
 * components) so the month/year arithmetic — including December → January
 * and leap-year edges — is unit-tested without rendering anything.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

/** The calendar month containing `today`, as UTC-midnight boundaries (inclusive). */
export function currentMonthRange(today: Date = new Date()): DateRange {
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from, to };
}

/** The calendar month immediately before `range`'s month. */
export function previousMonthRange(range: DateRange): DateRange {
  const from = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 0));
  return { from, to };
}

/** The same calendar month one year earlier. */
export function sameMonthLastYearRange(range: DateRange): DateRange {
  const from = new Date(Date.UTC(range.from.getUTCFullYear() - 1, range.from.getUTCMonth(), 1));
  const to = new Date(Date.UTC(range.from.getUTCFullYear() - 1, range.from.getUTCMonth() + 1, 0));
  return { from, to };
}

/** The same number of days immediately before `range.from`, for an arbitrary (non-month) custom range. */
export function precedingRangeOfSameLength(range: DateRange): DateRange {
  const lengthMs = range.to.getTime() - range.from.getTime();
  const to = new Date(range.from.getTime() - 24 * 60 * 60 * 1000);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
}

export type ComparisonMode = "previous_period" | "previous_year" | "none";

export function resolveComparisonRange(range: DateRange, mode: ComparisonMode): DateRange | undefined {
  if (mode === "none") return undefined;
  if (mode === "previous_year") return sameMonthLastYearRange(range);
  // "previous_period": use the calendar-month-aware version when `range`
  // looks like a full calendar month, otherwise fall back to "same length,
  // immediately before" for a custom range.
  const isFullCalendarMonth =
    range.from.getUTCDate() === 1 &&
    range.to.getTime() === new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth() + 1, 0)).getTime();
  return isFullCalendarMonth ? previousMonthRange(range) : precedingRangeOfSameLength(range);
}

/** Parses a `YYYY-MM-DD` search-param string into a UTC-midnight Date, or `undefined` if absent/invalid. */
export function parseDateParam(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A single reporting column: a labeled date range. Shared by the report builder (`report-builder-service.ts`) and NL reporting's monthly/quarterly breakdowns. */
export interface ReportColumn {
  label: string;
  from: Date;
  to: Date;
}

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "short", timeZone: "UTC" });
const QUARTER_LABEL = (year: number, quarter: number) => `Q${quarter} ${year}`;

/**
 * Splits `range` into consecutive calendar-month columns, UTC-anchored like
 * every other date boundary in this module. The first and last columns are
 * clipped to `range`'s own start/end rather than always being full calendar
 * months — e.g. a range starting mid-month gives a short first column — so
 * no day outside the requested range is ever double-counted or dropped.
 */
export function monthlyColumns(range: DateRange): ReportColumn[] {
  const columns: ReportColumn[] = [];
  let cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
  while (cursor.getTime() <= range.to.getTime()) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const from = cursor.getTime() > range.from.getTime() ? cursor : range.from;
    const to = monthEnd.getTime() < range.to.getTime() ? monthEnd : range.to;
    columns.push({ label: MONTH_LABEL_FORMAT.format(cursor), from, to });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return columns;
}

/** Same idea as `monthlyColumns`, grouped into calendar quarters (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec) instead of months. */
export function quarterlyColumns(range: DateRange): ReportColumn[] {
  const columns: ReportColumn[] = [];
  const startQuarterMonth = Math.floor(range.from.getUTCMonth() / 3) * 3;
  let cursor = new Date(Date.UTC(range.from.getUTCFullYear(), startQuarterMonth, 1));
  while (cursor.getTime() <= range.to.getTime()) {
    const quarterEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 0));
    const from = cursor.getTime() > range.from.getTime() ? cursor : range.from;
    const to = quarterEnd.getTime() < range.to.getTime() ? quarterEnd : range.to;
    const quarter = Math.floor(cursor.getUTCMonth() / 3) + 1;
    columns.push({ label: QUARTER_LABEL(cursor.getUTCFullYear(), quarter), from, to });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 1));
  }
  return columns;
}

/** `range` as a single column, labeled with its own start–end dates. */
export function singleColumn(range: DateRange): ReportColumn[] {
  return [{ label: `${formatDateParam(range.from)} – ${formatDateParam(range.to)}`, from: range.from, to: range.to }];
}

/** The last `n` whole calendar months up to and including the month containing `today`. */
export function lastNMonths(n: number, today: Date = new Date()): DateRange {
  const to = currentMonthRange(today).to;
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (n - 1), 1));
  return { from, to };
}

/** The last `n` whole calendar quarters up to and including the quarter containing `today`. */
export function lastNQuarters(n: number, today: Date = new Date()): DateRange {
  const currentQuarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  const to = new Date(Date.UTC(today.getUTCFullYear(), currentQuarterStartMonth + 3, 0));
  const from = new Date(Date.UTC(today.getUTCFullYear(), currentQuarterStartMonth - 3 * (n - 1), 1));
  return { from, to };
}

/** The calendar quarter containing `today`. */
export function currentQuarterRange(today: Date = new Date()): DateRange {
  const startMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  const from = new Date(Date.UTC(today.getUTCFullYear(), startMonth, 1));
  const to = new Date(Date.UTC(today.getUTCFullYear(), startMonth + 3, 0));
  return { from, to };
}

/** The calendar quarter immediately before `range`'s quarter. */
export function previousQuarterRange(range: DateRange): DateRange {
  const startMonth = Math.floor(range.from.getUTCMonth() / 3) * 3;
  const to = new Date(Date.UTC(range.from.getUTCFullYear(), startMonth, 0));
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 2, 1));
  return { from, to };
}

/** The calendar year containing `today`. */
export function currentYearRange(today: Date = new Date()): DateRange {
  return { from: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), to: new Date(Date.UTC(today.getUTCFullYear(), 11, 31)) };
}

/** The calendar year immediately before `range`'s year. */
export function previousYearRange(range: DateRange): DateRange {
  return {
    from: new Date(Date.UTC(range.from.getUTCFullYear() - 1, 0, 1)),
    to: new Date(Date.UTC(range.from.getUTCFullYear() - 1, 11, 31)),
  };
}
