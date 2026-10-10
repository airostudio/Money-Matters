/**
 * Recurring deadline rules, entered BY THE PRACTICE (docs/accounting-engine.md,
 * "Practice tax calendar"). The system performs date arithmetic on a rule the
 * user wrote; it does NOT know any tax authority's due dates, and nothing here
 * is hardcoded from tax law. Starter templates are only form prefills the user
 * must verify and may edit.
 *
 * A rule is: a frequency, the calendar month in which a period ends, how many
 * whole months after the period end the deadline falls, and the day of that
 * month (clamped to its length, so "31" in February is the 28th/29th).
 *
 *   MONTHLY    period ends on the last day of every month
 *   QUARTERLY  period ends on the last day of every third month, counted from `periodEndMonth`
 *   ANNUAL     period ends on the last day of `periodEndMonth` each year
 */
export type DeadlineFrequency = "MONTHLY" | "QUARTERLY" | "ANNUAL";

export interface DeadlineRule {
  frequency: DeadlineFrequency;
  /** 1-12. */
  periodEndMonth: number;
  /** 0-12. */
  dueMonthsAfter: number;
  /** 1-31. */
  dueDay: number;
}

export interface Occurrence {
  /** The last day of the period, YYYY-MM-DD. */
  periodEnd: string;
  /** The deadline, YYYY-MM-DD. */
  dueDate: string;
}

export class InvalidDeadlineRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeadlineRuleError";
  }
}

export function validateRule(rule: DeadlineRule): void {
  if (!["MONTHLY", "QUARTERLY", "ANNUAL"].includes(rule.frequency)) throw new InvalidDeadlineRuleError("Frequency must be MONTHLY, QUARTERLY or ANNUAL.");
  const int = (n: number, lo: number, hi: number, label: string) => {
    if (!Number.isInteger(n) || n < lo || n > hi) throw new InvalidDeadlineRuleError(`${label} must be a whole number from ${lo} to ${hi}.`);
  };
  int(rule.periodEndMonth, 1, 12, "Period end month");
  int(rule.dueMonthsAfter, 0, 12, "Months after period end");
  int(rule.dueDay, 1, 31, "Due day");
}

const pad = (n: number) => String(n).padStart(2, "0");

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Adds whole months to a (year, month) pair, month 1-12. */
function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function endsPeriod(rule: DeadlineRule, month: number): boolean {
  switch (rule.frequency) {
    case "MONTHLY":
      return true;
    case "QUARTERLY":
      return (((month - rule.periodEndMonth) % 3) + 3) % 3 === 0;
    case "ANNUAL":
      return month === rule.periodEndMonth;
  }
}

/**
 * The next `count` occurrences whose DEADLINE is on or after `from` (YYYY-MM-DD),
 * in date order. Deterministic and side-effect free.
 */
export function nextOccurrences(rule: DeadlineRule, from: string, count: number): Occurrence[] {
  validateRule(rule);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new InvalidDeadlineRuleError("Date must be YYYY-MM-DD.");
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new InvalidDeadlineRuleError("Count must be from 1 to 24.");

  const fromYear = Number(from.slice(0, 4));
  const fromMonth = Number(from.slice(5, 7));
  // A deadline on/after `from` can belong to a period that ended up to `dueMonthsAfter` months earlier.
  let cursor = addMonths(fromYear, fromMonth, -(rule.dueMonthsAfter + 1));
  const out: Occurrence[] = [];
  // At most ~ (12 + count*12) months of scanning is ever needed; the bound makes termination obvious.
  for (let i = 0; i < 24 * 12 + 24 && out.length < count; i += 1) {
    if (endsPeriod(rule, cursor.month)) {
      const due = addMonths(cursor.year, cursor.month, rule.dueMonthsAfter);
      const day = Math.min(rule.dueDay, daysInMonth(due.year, due.month));
      const dueDate = ymd(due.year, due.month, day);
      if (dueDate >= from) {
        out.push({ periodEnd: ymd(cursor.year, cursor.month, daysInMonth(cursor.year, cursor.month)), dueDate });
      }
    }
    cursor = addMonths(cursor.year, cursor.month, 1);
  }
  return out;
}

/**
 * Starter FORM PREFILLS only. They are suggestions the user must verify against
 * the relevant tax authority's own published dates (for Australian lodgements,
 * ato.gov.au) before saving; nothing here is authoritative and nothing is
 * created without the user saving it. Deliberately generic names.
 */
export const STARTER_TEMPLATES: Array<{ name: string; category: "BAS" | "TAX" | "PAYROLL"; rule: DeadlineRule }> = [
  { name: "Quarterly activity statement (suggestion — verify the due day)", category: "BAS", rule: { frequency: "QUARTERLY", periodEndMonth: 6, dueMonthsAfter: 1, dueDay: 28 } },
  { name: "Monthly activity statement (suggestion — verify the due day)", category: "BAS", rule: { frequency: "MONTHLY", periodEndMonth: 12, dueMonthsAfter: 1, dueDay: 21 } },
  { name: "Annual return preparation (suggestion — set your own date)", category: "TAX", rule: { frequency: "ANNUAL", periodEndMonth: 6, dueMonthsAfter: 4, dueDay: 31 } },
];
