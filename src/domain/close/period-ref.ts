/**
 * Period references for the close workspace. A fiscal period may not exist as
 * a row at all (periods are created explicitly — `FiscalPeriodService.create`
 * — never lazily by a posting), so the workspace addresses a period either by
 * its calendar-month key (`YYYY-MM`, which works for months that exist only
 * implicitly) or by a `fiscal_periods` id (annual/quarterly/custom ranges).
 * Pure helpers, no I/O.
 */

export type PeriodRef = { kind: "month"; year: number; month: number } | { kind: "id"; id: string };

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidPeriodRefError extends Error {
  constructor(ref: string) {
    super(`"${ref}" is not a valid period reference (use YYYY-MM or a period id).`);
    this.name = "InvalidPeriodRefError";
  }
}

export function parsePeriodRef(ref: string): PeriodRef {
  const m = MONTH_KEY.exec(ref);
  if (m) return { kind: "month", year: Number(m[1]), month: Number(m[2]) };
  if (UUID.test(ref)) return { kind: "id", id: ref.toLowerCase() };
  throw new InvalidPeriodRefError(ref);
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Start (midnight UTC, day 1) and end (midnight UTC of the LAST day — the same convention every existing period uses) of a month. */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
  };
}

/** The last instant of the UTC day `end` falls on — what "through the period end" means for timestamped data. */
export function endOfDayUtc(end: Date): Date {
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
}

export function dayBefore(date: Date): Date {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}

export function monthKeyOf(date: Date): string {
  return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function periodRefKey(ref: PeriodRef): string {
  return ref.kind === "month" ? monthKey(ref.year, ref.month) : ref.id;
}

/** Whether [start, end] is exactly one calendar month (UTC). */
export function isCalendarMonth(start: Date, end: Date): boolean {
  const b = monthBounds(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return b.start.getTime() === start.getTime() && b.end.getTime() === end.getTime();
}

/** The `YYYY-MM-01` start of the month containing `d` — depreciation's period key. */
export function monthStartOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
