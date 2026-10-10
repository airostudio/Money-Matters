/**
 * Deterministic "Collection Priority Score" — master spec §15's smart debt
 * collection formula inputs (invoice amount, days overdue, and the
 * customer's historical average payment time), with no AI drafting in this
 * slice (see docs/roadmap.md for why AI-drafted reminder emails are
 * deferred). Pure, DB-free scoring so it's exercised directly by unit
 * tests; `AgedReceivablesService.getWithPriority` supplies the three real
 * inputs per overdue invoice.
 *
 * Each input is normalized to a 0–100 sub-score before weighting, so the
 * three factors — which live on very different natural scales (dollars,
 * days, days) — combine meaningfully instead of one dominating by raw
 * magnitude. Weights sum to 1 and are the tunable part of the formula:
 *
 *   - `daysPastDue`           (weight 0.5): the single strongest signal —
 *     an invoice's own aging is what "who to chase first" is fundamentally
 *     about. Reaches its max at `DAYS_OVERDUE_CEILING` days overdue.
 *   - `outstandingAmount`     (weight 0.3): a large unpaid invoice deserves
 *     more attention than a small one at the same age. Reaches its max at
 *     `AMOUNT_CEILING` in the invoice's own currency units.
 *   - `customerAvgDaysLate`   (weight 0.2): a customer who has historically
 *     paid well past their due date is a bigger collection risk than one
 *     who has always paid close to on time, even at the same current
 *     age/amount. `null` (no settled invoice history yet for this
 *     customer) scores as neutral risk (50) rather than 0 or 100 — an
 *     unknown payer is not assumed either reliable or risky.
 */

export const COLLECTION_PRIORITY_WEIGHTS = {
  daysPastDue: 0.5,
  outstandingAmount: 0.3,
  customerAvgDaysLate: 0.2,
} as const;

const DAYS_OVERDUE_CEILING = 90;
const AMOUNT_CEILING = 10_000;
const AVG_DAYS_LATE_CEILING = 60;
const NEUTRAL_HISTORY_SCORE = 50;

export interface CollectionPriorityInput {
  /** The invoice's own outstanding balance, in its currency's decimal units (e.g. "1234.56"). */
  outstandingAmount: string;
  /** Days past the invoice's due date, as of the scoring date. Zero or negative (not yet due) scores 0. */
  daysPastDue: number;
  /**
   * This customer's historical average days late (settlement date minus due
   * date, across their own already-PAID invoices) — negative means they
   * typically pay early. `null` when the customer has no settled invoice
   * history yet.
   */
  customerAvgDaysLate: number | null;
}

function clampToUnitPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 0–100, scaled linearly against `DAYS_OVERDUE_CEILING`, capped both ends. */
function daysPastDueScore(daysPastDue: number): number {
  return clampToUnitPercent((daysPastDue / DAYS_OVERDUE_CEILING) * 100);
}

/** 0–100, scaled linearly against `AMOUNT_CEILING`, capped both ends. */
function outstandingAmountScore(outstandingAmount: string): number {
  const amount = Number(outstandingAmount);
  return clampToUnitPercent((amount / AMOUNT_CEILING) * 100);
}

/** 0–100; `null` (no history) is neutral, negative (pays early) floors at 0, scaled against `AVG_DAYS_LATE_CEILING`. */
function customerHistoryScore(customerAvgDaysLate: number | null): number {
  if (customerAvgDaysLate === null) return NEUTRAL_HISTORY_SCORE;
  return clampToUnitPercent((customerAvgDaysLate / AVG_DAYS_LATE_CEILING) * 100);
}

/**
 * Returns a 0–100 priority score (higher = chase sooner), rounded to two
 * decimal places so it reads cleanly as a sortable column.
 */
export function calculateCollectionPriorityScore(input: CollectionPriorityInput): number {
  const score =
    daysPastDueScore(input.daysPastDue) * COLLECTION_PRIORITY_WEIGHTS.daysPastDue +
    outstandingAmountScore(input.outstandingAmount) * COLLECTION_PRIORITY_WEIGHTS.outstandingAmount +
    customerHistoryScore(input.customerAvgDaysLate) * COLLECTION_PRIORITY_WEIGHTS.customerAvgDaysLate;

  return Math.round(score * 100) / 100;
}
