import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";

/**
 * Pure rules for the digital working paper (master spec s.43,
 * docs/accounting-engine.md "Workpaper reconciliation method"). Exact decimal
 * arithmetic throughout — amounts are decimal STRINGS with at most 4 decimal
 * places, never floats.
 */

export type ScheduleLineKind = "SUPPORTING_BALANCE" | "RECONCILING_ITEM";

export interface ScheduleLine {
  kind: ScheduleLineKind;
  description: string;
  reference?: string | null;
  /** Signed decimal string. A reconciling item that reduces the supporting balance is negative. */
  amount: string;
  isRecurring?: boolean;
}

export class InvalidAmountError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid amount (use a plain decimal such as 12450.00 or -450.00, up to 4 decimal places).`);
    this.name = "InvalidAmountError";
  }
}

const AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;

/** Parses a user-entered amount into an exact Decimal, rejecting anything that is not a plain decimal. */
export function parseAmount(value: string): Decimal {
  const trimmed = String(value).trim().replace(/,/g, "");
  if (!AMOUNT.test(trimmed)) throw new InvalidAmountError(String(value));
  return new Decimal(trimmed);
}

/** 2 decimal places, unless a sub-cent residue exists — then all 4, so a non-zero difference is never displayed as 0.00. */
export function fmt(d: Decimal): string {
  return d.decimalPlaces() > 2 ? d.toFixed(4) : d.toFixed(2);
}

export interface ReconciliationResult {
  /** The ledger balance in the account's normal direction, 2 dp. */
  ledgerBalance: string;
  /** Sum of every schedule line (supporting balances plus signed reconciling items), 2 dp. */
  scheduleTotal: string;
  /** ledgerBalance - scheduleTotal, 2 dp. Zero means the schedule explains the ledger exactly. */
  difference: string;
  isReconciled: boolean;
}

/**
 * The reconciliation: the SUPPORTING schedule (e.g. bank statement balance plus the signed
 * reconciling items — outstanding cheques, deposits in transit) is added up and compared to
 * the ledger balance as at the same date. difference = ledger - schedule total, so a negative
 * difference means the ledger is LOWER than the schedule supports.
 *
 *   ledger 12,000.00; statement 12,450.00; outstanding items -450.00
 *     -> schedule total 12,000.00; difference 0.00 (reconciled)
 */
export function reconcile(ledgerBalance: string, lines: ScheduleLine[], currency = "AUD"): ReconciliationResult {
  const ledger = Money.of(parseAmount(ledgerBalance), currency);
  const total = lines.reduce((sum, l) => sum.add(Money.of(parseAmount(l.amount), currency)), Money.zero(currency));
  const difference = ledger.subtract(total);
  return {
    ledgerBalance: fmt(ledger.toDecimal()),
    scheduleTotal: fmt(total.toDecimal()),
    difference: fmt(difference.toDecimal()),
    isReconciled: difference.isZero(),
  };
}

export interface StalenessResult {
  stale: boolean;
  /** current - snapshot, 2 dp (0.00 when not stale). */
  change: string;
}

/** Has the ledger balance moved since the snapshot? Exact comparison — any change, however small, is stale. */
export function compareSnapshotToLedger(snapshotBalance: string, currentBalance: string, currency = "AUD"): StalenessResult {
  const delta = Money.of(parseAmount(currentBalance), currency).subtract(Money.of(parseAmount(snapshotBalance), currency));
  return { stale: !delta.isZero(), change: fmt(delta.toDecimal()) };
}

// ------------------------------------------------------------------- carry-forward

export interface CarryForwardSource {
  periodEnd: string;
  ledgerBalance: string;
  lines: ScheduleLine[];
}

export interface CarryForwardPlan {
  /** The prior period's ledger balance, shown as the comparative — copied, never recomputed. */
  priorPeriodEnd: string;
  priorLedgerBalance: string;
  /** Lines for the new workpaper, in order. */
  lines: ScheduleLine[];
  /** What was done with each source line, for the audit trail and the UI. */
  disposition: Array<{ description: string; kind: ScheduleLineKind; outcome: "COPIED_RECURRING" | "STRUCTURE_ONLY_ZEROED" | "DROPPED" }>;
}

/**
 * What carries forward from a SIGNED-OFF workpaper into the next period's:
 *  - the schedule STRUCTURE: every supporting-balance line (e.g. "Bank statement balance") is
 *    kept with its description and reference but its amount is reset to 0.00 — it must be
 *    re-entered from the new period's evidence;
 *  - RECURRING reconciling items are copied with their amounts (the preparer then confirms or
 *    clears them);
 *  - every other reconciling item is dropped (it belonged to the old period);
 *  - the prior ledger balance is carried as the comparative.
 * NEVER carried: evidence, sign-offs, review notes, proposed adjustments, the balance snapshot.
 */
export function planCarryForward(source: CarryForwardSource): CarryForwardPlan {
  const lines: ScheduleLine[] = [];
  const disposition: CarryForwardPlan["disposition"] = [];
  for (const l of source.lines) {
    if (l.kind === "SUPPORTING_BALANCE") {
      lines.push({ kind: l.kind, description: l.description, reference: l.reference ?? null, amount: "0.0000", isRecurring: l.isRecurring ?? false });
      disposition.push({ description: l.description, kind: l.kind, outcome: "STRUCTURE_ONLY_ZEROED" });
    } else if (l.isRecurring) {
      lines.push({ kind: l.kind, description: l.description, reference: l.reference ?? null, amount: parseAmount(l.amount).toFixed(4), isRecurring: true });
      disposition.push({ description: l.description, kind: l.kind, outcome: "COPIED_RECURRING" });
    } else {
      disposition.push({ description: l.description, kind: l.kind, outcome: "DROPPED" });
    }
  }
  return {
    priorPeriodEnd: source.periodEnd,
    priorLedgerBalance: parseAmount(source.ledgerBalance).toFixed(4),
    lines,
    disposition,
  };
}

/** The last day of the month after `periodEnd` (YYYY-MM-DD) — the default next period for a month-end reconciliation. */
export function suggestNextPeriodEnd(periodEnd: string): string {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(5, 7));
  const last = new Date(Date.UTC(y, m + 1, 0)); // day 0 of month m+2 (1-based) = last day of month m+1
  return last.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- segregation of duties

export interface SignoffRuleInput {
  preparerUserId: string;
  signerUserId: string;
  /** Active members of the practice (the colleague directory count). */
  activeStaffCount: number;
}

export interface SignoffRuleResult {
  allowed: boolean;
  /** True when the preparer is allowed to review their own work ONLY because the practice has a single active staff member. */
  singleStaffException: boolean;
  reason?: string;
}

/**
 * Reviewer != preparer wherever the practice has two or more active staff. A one-person
 * practice cannot have a second pair of eyes, so there — and only there — the preparer may
 * also sign as reviewer; the sign-off is then flagged `singleStaffException` in the history
 * and the audit log (the same documented exception the payment-run slice makes).
 */
export function evaluateReviewerSignoff(input: SignoffRuleInput): SignoffRuleResult {
  if (input.signerUserId !== input.preparerUserId) return { allowed: true, singleStaffException: false };
  if (input.activeStaffCount <= 1) return { allowed: true, singleStaffException: true };
  return {
    allowed: false,
    singleStaffException: false,
    reason: "The reviewer must be a different person from the preparer — ask a colleague to review this workpaper.",
  };
}
