import Decimal from "decimal.js";
// Side-effect only: sets decimal.js's global precision/rounding
// (ROUND_HALF_EVEN) to the ledger's convention. decimal.js's `Decimal` is a
// single module-level singleton, so this must run before any Decimal math
// below — importing `Money` for its side effect, rather than duplicating
// the `Decimal.set` call, keeps that configuration defined in exactly one
// place (see docs/decisions/0003-monetary-precision.md).
import "@/domain/money/money";
import { InvalidDepreciationRunError } from "./errors";

/**
 * Pure, DB-free straight-line depreciation math (master spec §28) — the
 * fixed-assets mirror of `src/domain/inventory/costing.ts`: no database
 * access, exercised directly by unit tests against hand-computed inputs.
 * Every amount is a `decimal.js` value from the moment it's parsed, never a
 * floating-point intermediate, per docs/accounting-engine.md §4.
 *
 * **Only straight-line is implemented.** Declining-balance,
 * units-of-production, and sum-of-years-digits (all mentioned in master
 * spec §28) are deliberately deferred rather than half-built alongside it:
 * each needs its own proration rule (declining-balance re-bases off net
 * book value every period, not a fixed monthly amount; units-of-production
 * needs a usage/output figure this codebase has nowhere to source from) and
 * its own test matrix, and `depreciationMethodEnum` is a Postgres enum with
 * a single value today specifically so a second method can be added later
 * as a new value with no schema restructuring — the same reasoning
 * `inventoryCostingMethodEnum` documents for FIFO.
 *
 * **Period granularity is the calendar month.** `runForPeriod` always asks
 * "how much depreciation for asset X in calendar month Y" — a deliberate,
 * simple choice (master spec §28 just says "generate depreciation journals
 * automatically", not any particular cadence) that makes idempotency a
 * structural property: a (asset, calendar month) pair can be run at most
 * once, enforced by `depreciation_entries`' unique index, not just a
 * convention callers have to honor.
 */

export interface StraightLineDepreciationInput {
  acquisitionDate: Date;
  /** Decimal string. */
  acquisitionCost: string;
  /** Decimal string, >= 0. */
  residualValue: string;
  usefulLifeMonths: number;
  /** Decimal string — this asset's `accumulatedDepreciation` immediately BEFORE this period's run. */
  accumulatedDepreciationBefore: string;
  /** The first calendar day of the period being depreciated, UTC midnight. */
  periodStart: Date;
  /** The last calendar day of the period being depreciated, UTC midnight. */
  periodEnd: Date;
}

export interface StraightLineDepreciationResult {
  /** Decimal string, >= 0 — this period's depreciation charge. "0" when the asset wasn't yet acquired as of `periodEnd`, or is already fully depreciated. */
  amount: string;
  /** `accumulatedDepreciationBefore + amount`, decimal string. Never exceeds `acquisitionCost - residualValue` — see this module's doc comment on capping. */
  accumulatedDepreciationAfter: string;
}

function parseNonNegativeDecimal(value: string, label: string): Decimal {
  if (value === undefined || value === null || value.trim() === "") {
    throw new InvalidDepreciationRunError(`${label} is required.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new InvalidDepreciationRunError(`${label} must be a plain decimal number.`);
  }
  const decimal = new Decimal(value.trim());
  if (decimal.isNegative()) {
    throw new InvalidDepreciationRunError(`${label} cannot be negative.`);
  }
  return decimal;
}

/** Whole calendar days between `from` and `to`, inclusive of both ends, using UTC calendar dates (never a millisecond/DST-sensitive diff). */
function inclusiveDayCount(from: Date, to: Date): number {
  const fromUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUtc = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((toUtc - fromUtc) / 86_400_000) + 1;
}

function laterDate(a: Date, b: Date): Date {
  return a.getTime() > b.getTime() ? a : b;
}

/**
 * This asset's straight-line depreciation for one calendar-month period.
 *
 * - `monthlyAmount = (acquisitionCost - residualValue) / usefulLifeMonths`,
 *   the textbook formula, rounded to the ledger's 4 decimal places with the
 *   same `ROUND_HALF_EVEN` convention `Money` uses globally (set once via
 *   `Decimal.set` in `src/domain/money/money.ts`, which this module relies
 *   on having already run — every entry point into this codebase imports
 *   `Money` before any domain logic runs).
 * - **Not yet acquired**: `acquisitionDate` after `periodEnd` → `0`.
 * - **Mid-period acquisition**: prorated by whole days — `monthlyAmount ×
 *   daysServed / totalDaysInPeriod`, where `daysServed` counts from
 *   `max(acquisitionDate, periodStart)` to `periodEnd` inclusive and
 *   `totalDaysInPeriod` counts the whole period. An asset acquired on the
 *   period's first day gets the full `monthlyAmount` (no proration needed,
 *   and the formula naturally produces it since daysServed ==
 *   totalDaysInPeriod).
 * - **Capped at the depreciable base**: the result never lets
 *   `accumulatedDepreciationAfter` exceed `acquisitionCost - residualValue`
 *   — the final period's charge is whatever remains, even if that's less
 *   than a full/prorated `monthlyAmount`. Once fully depreciated, every
 *   later period returns `0` — the asset sits at residual value on the
 *   books until disposed.
 */
export function calculateStraightLineDepreciation(
  input: StraightLineDepreciationInput,
): StraightLineDepreciationResult {
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
    throw new InvalidDepreciationRunError("usefulLifeMonths must be a positive whole number.");
  }
  if (input.periodEnd.getTime() < input.periodStart.getTime()) {
    throw new InvalidDepreciationRunError("periodEnd cannot be before periodStart.");
  }

  const cost = parseNonNegativeDecimal(input.acquisitionCost, "Acquisition cost");
  const residual = parseNonNegativeDecimal(input.residualValue, "Residual value");
  if (residual.greaterThan(cost)) {
    throw new InvalidDepreciationRunError("Residual value cannot exceed acquisition cost.");
  }
  const accumulatedBefore = parseNonNegativeDecimal(
    input.accumulatedDepreciationBefore,
    "Accumulated depreciation",
  );

  const depreciableBase = cost.minus(residual);
  const remaining = depreciableBase.minus(accumulatedBefore);

  if (input.acquisitionDate.getTime() > input.periodEnd.getTime() || remaining.lessThanOrEqualTo(0)) {
    return {
      amount: "0.0000",
      accumulatedDepreciationAfter: accumulatedBefore.toFixed(4),
    };
  }

  const monthlyAmount = depreciableBase.dividedBy(input.usefulLifeMonths);

  const acquiredOnOrBeforePeriod = input.acquisitionDate.getTime() <= input.periodStart.getTime();
  const rawAmount = acquiredOnOrBeforePeriod
    ? monthlyAmount
    : monthlyAmount
        .times(inclusiveDayCount(laterDate(input.acquisitionDate, input.periodStart), input.periodEnd))
        .dividedBy(inclusiveDayCount(input.periodStart, input.periodEnd));

  const amount = Decimal.min(rawAmount, remaining).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);

  return {
    amount: amount.toFixed(4),
    accumulatedDepreciationAfter: accumulatedBefore.plus(amount).toFixed(4),
  };
}

/**
 * This asset's full projected depreciation schedule, straight-line,
 * calendar-month by calendar-month from its acquisition date to the end of
 * its useful life — the "per-asset depreciation schedule" report (master
 * spec §28). Purely projected arithmetic with no notion of what has
 * actually been run/posted (`FixedAssetRegisterService` combines this with
 * the real `depreciation_entries` history to show "actual so far, projected
 * from here"); a disposed/written-off asset's remaining schedule is
 * meaningless and callers should not call this for one.
 */
export interface DepreciationScheduleRow {
  periodStart: string;
  periodEnd: string;
  amount: string;
  accumulatedDepreciationAfter: string;
  netBookValueAfter: string;
}

export function projectDepreciationSchedule(input: {
  acquisitionDate: Date;
  acquisitionCost: string;
  residualValue: string;
  usefulLifeMonths: number;
}): DepreciationScheduleRow[] {
  const cost = parseNonNegativeDecimal(input.acquisitionCost, "Acquisition cost");
  const residual = parseNonNegativeDecimal(input.residualValue, "Residual value");
  const depreciableBase = cost.minus(residual);
  const rows: DepreciationScheduleRow[] = [];

  let accumulated = "0.0000";
  let cursor = new Date(
    Date.UTC(input.acquisitionDate.getUTCFullYear(), input.acquisitionDate.getUTCMonth(), 1),
  );

  // Normally exactly `usefulLifeMonths` periods fully depreciate the asset.
  // A mid-period acquisition prorates the first period down, deferring a
  // less-than-one-month shortfall that the very next period after the
  // nominal last one absorbs — so at most ONE extra period is ever needed;
  // the `+ 1` is that, not an open-ended loop, and the `remaining > 0` exit
  // stops as soon as the depreciable base is fully consumed (the common,
  // unprorated case) rather than padding the schedule with trailing $0 rows.
  const maxPeriods = input.usefulLifeMonths + 1;

  for (let i = 0; i < maxPeriods; i++) {
    const remaining = depreciableBase.minus(new Decimal(accumulated));
    if (remaining.lessThanOrEqualTo(0)) break;

    const periodStart = cursor;
    const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0));

    const result = calculateStraightLineDepreciation({
      acquisitionDate: input.acquisitionDate,
      acquisitionCost: input.acquisitionCost,
      residualValue: input.residualValue,
      usefulLifeMonths: input.usefulLifeMonths,
      accumulatedDepreciationBefore: accumulated,
      periodStart,
      periodEnd,
    });

    rows.push({
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      amount: result.amount,
      accumulatedDepreciationAfter: result.accumulatedDepreciationAfter,
      netBookValueAfter: cost.minus(new Decimal(result.accumulatedDepreciationAfter)).toFixed(4),
    });

    accumulated = result.accumulatedDepreciationAfter;
    cursor = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  }

  return rows;
}
