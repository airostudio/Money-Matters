import Decimal from "decimal.js";
import type { PayFrequency } from "./payg-calculations";
import { PAY_PERIODS_PER_YEAR } from "./payg-calculations";

/**
 * NES (National Employment Standards, Fair Work Act) leave entitlements —
 * long-standing, stable figures, lower regulatory-change risk than tax
 * rates, but still cited: a full-time employee (38 hours/week) accrues 4
 * weeks annual leave/year (152 hours/year) and 10 days personal/carer's
 * leave/year (76 hours/year), both accrued progressively per pay period —
 * source: Fair Work Act / Fair Work Ombudsman NES summary. See
 * docs/roadmap.md for the full citation.
 */
export const NES_FULL_TIME_STANDARD_HOURS_PER_WEEK = new Decimal(38);
export const NES_ANNUAL_LEAVE_HOURS_PER_YEAR = new Decimal(152);
export const NES_PERSONAL_LEAVE_HOURS_PER_YEAR = new Decimal(76);

export interface LeaveAccrualInput {
  employmentBasis: "SALARY" | "HOURLY";
  payFrequency: PayFrequency;
  /** Decimal string — this employee's standard/contracted hours per week (38 for a standard full-timer). Used to pro-rate both the SALARY per-period fraction and the HOURLY actual-hours fraction against the NES full-time base. */
  standardHoursPerWeek: string;
  /** Decimal string — only meaningful for HOURLY; the actual hours this pay run paid for. Ignored for SALARY. */
  hoursPaidThisPeriod?: string;
}

export interface LeaveAccrualResult {
  annualLeaveAccruedHours: Decimal;
  personalLeaveAccruedHours: Decimal;
}

/**
 * Accrues NES annual + personal leave for one pay run (master spec §25 —
 * leave-entitlement math only, no rostering/shifts, no leave-request
 * workflow in this slice). Two accrual bases, both pro-rated against the
 * 38-hour/152-hour/76-hour full-time NES figures above:
 *
 * - SALARY: pro-rated by the PERIOD FRACTION of a year (one pay period's
 *   share of 52/26/12 periods/year), scaled by `standardHoursPerWeek /
 *   38` for a part-time salaried employee.
 * - HOURLY: pro-rated by actual `hoursPaidThisPeriod` against a standard
 *   38-hour working year's worth of weeks (`hoursPaidThisPeriod / (38 ×
 *   52)` of the annual entitlement) — so an hourly employee who works more
 *   or fewer hours than usual this period accrues proportionally more or
 *   less leave, exactly reflecting hours actually worked rather than a
 *   flat per-period amount.
 */
export function calculateLeaveAccrual(input: LeaveAccrualInput): LeaveAccrualResult {
  const standardHours = new Decimal(input.standardHoursPerWeek);
  const partTimeFraction = standardHours.dividedBy(NES_FULL_TIME_STANDARD_HOURS_PER_WEEK);

  if (input.employmentBasis === "SALARY") {
    const periodsPerYear = PAY_PERIODS_PER_YEAR[input.payFrequency];
    const periodFraction = new Decimal(1).dividedBy(periodsPerYear);
    return {
      annualLeaveAccruedHours: NES_ANNUAL_LEAVE_HOURS_PER_YEAR.times(partTimeFraction)
        .times(periodFraction)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN),
      personalLeaveAccruedHours: NES_PERSONAL_LEAVE_HOURS_PER_YEAR.times(partTimeFraction)
        .times(periodFraction)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN),
    };
  }

  // HOURLY: pro-rate by hours actually paid this period against a standard
  // full-time working year of hours (38 hours/week x 52 weeks).
  const hoursPaid = new Decimal(input.hoursPaidThisPeriod ?? "0");
  const standardWorkingYearHours = NES_FULL_TIME_STANDARD_HOURS_PER_WEEK.times(52);
  const hoursFraction = standardWorkingYearHours.isZero() ? new Decimal(0) : hoursPaid.dividedBy(standardWorkingYearHours);

  return {
    annualLeaveAccruedHours: NES_ANNUAL_LEAVE_HOURS_PER_YEAR.times(hoursFraction).toDecimalPlaces(
      4,
      Decimal.ROUND_HALF_EVEN,
    ),
    personalLeaveAccruedHours: NES_PERSONAL_LEAVE_HOURS_PER_YEAR.times(hoursFraction).toDecimalPlaces(
      4,
      Decimal.ROUND_HALF_EVEN,
    ),
  };
}
