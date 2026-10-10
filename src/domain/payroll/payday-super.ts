/**
 * Payday Super (SG paid with each payday) - Phase 8 Slice 4(g).
 *
 * Facts used, each cross-confirmed from at least two independent sources (see docs/roadmap.md, Phase 8 verified
 * figures): the Payday Super legislation passed Parliament in November 2025 and commenced on 1 July 2026; from then SG
 * is calculated on "qualifying earnings" (OTE plus commissions plus salary-sacrificed super) and the contribution must
 * be RECEIVED, with the information needed to allocate it, by the employee's fund within 7 business days of the
 * qualifying earnings (QE) day, generally payday; the maximum contribution base is an ANNUAL figure, $270,830 for
 * 2026-27, and the SG rate stays 12%. A "business day" is any day other than a Saturday, a Sunday or a day that is a
 * public holiday for the whole of any Australian state or territory.
 *
 * What this module deliberately does NOT do, and why:
 *  - It does not know the public holidays. A business day excludes whole-state public holidays in ANY state, and no
 *    verified holiday calendar is held here. Holidays can only make the true deadline LATER than a weekday-only count,
 *    so this module returns a conservative "safe-by" date: if the fund has RECEIVED the contribution by that date, the
 *    contribution is on time whichever way the QE day is counted and whatever holidays fall in between. It is NOT the
 *    legal deadline and is never presented as one.
 *  - It does not model clearing-house or bank processing time (the test is receipt by the fund, not the payment date).
 *  - It does not model commissions or salary-sacrificed super: every dollar of gross pay is treated as ordinary time
 *    earnings (the Slice 1 simplification), which is the QE for an employee with neither.
 *  - It does not model the first-super-contribution (new employee / stapled fund) timing that some sources describe
 *    with a different business-day count; those exceptions were not verified from an ATO page.
 */

/** Number of weekdays after the QE day used for the conservative safe-by date: 7 business days, counting the QE day itself as day 1 (the earliest reading). */
export const PAYDAY_SUPER_SAFE_WEEKDAYS = 6;

function isWeekday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/** Conservative date by which the fund should have RECEIVED the SG for a payday. Weekends excluded; public holidays NOT modelled (they can only extend the real deadline). */
export function paydaySuperSafeByDate(qeDay: Date): Date {
  const d = new Date(Date.UTC(qeDay.getUTCFullYear(), qeDay.getUTCMonth(), qeDay.getUTCDate()));
  let remaining = PAYDAY_SUPER_SAFE_WEEKDAYS;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWeekday(d)) remaining -= 1;
  }
  return d;
}

/** Australian financial year start (1 July, UTC) containing a date. */
export function australianFinancialYearStart(date: Date): Date {
  const y = date.getUTCFullYear();
  return new Date(Date.UTC(date.getUTCMonth() >= 6 ? y : y - 1, 6, 1));
}

export type SuperCadence = "QUARTERLY" | "PAYDAY";
