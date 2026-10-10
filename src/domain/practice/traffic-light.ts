import { SNAPSHOT_STALE_AFTER_HOURS } from "./types";

export type Light = "GREEN" | "AMBER" | "RED" | "GREY";

/** Unreconciled bank transactions above this count turn Reconciliation RED (1..this is AMBER). A documented threshold, not a tax rule. */
export const RECON_RED_THRESHOLD = 20;
/** A deadline this many days away (or fewer) is AMBER. */
export const DEADLINE_AMBER_DAYS = 7;

/** The raw, count-only facts a refresh stores. NULL means "not measured" (never zero). */
export interface HealthFacts {
  state: string;
  periodLabel: string | null;
  lockLevel: string | null;
  booksPercent: number | null;
  blockingCount: number | null;
  attentionCount: number | null;
  unreconciledCount: number | null;
  uncategorisedCount: number | null;
  draftPayRuns: number | null;
  taxLockedThrough: string | null;
}

/** What the VIEWER's own role in that client lets them see (the snapshot may have been refreshed by someone with more). */
export interface ViewerVisibility {
  books: boolean;
  reconciliation: boolean;
  payroll: boolean;
}

export interface DeadlineFacts {
  /** The earliest open BAS/TAX task's due date (YYYY-MM-DD), entered by the practice — never computed from tax law. */
  nextDueDate: string | null;
  nextTitle: string | null;
  overdueTasks: number;
}

export interface Indicator {
  light: Light;
  label: string;
}

export interface RowIndicators {
  books: Indicator;
  reconciliation: Indicator;
  tax: Indicator;
  payroll: Indicator;
  issues: number;
  /** 0 = nothing wrong; larger = more urgent. */
  severity: number;
  needsIntervention: boolean;
  neverRefreshed: boolean;
}

const RANK: Record<Light, number> = { GREEN: 0, GREY: 0, AMBER: 2, RED: 3 };
const HIDDEN: Indicator = { light: "GREY", label: "Not visible to your role" };

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function booksIndicator(f: HealthFacts | null, vis: ViewerVisibility): Indicator {
  if (!vis.books) return HIDDEN;
  if (!f || f.state !== "OK" || f.booksPercent === null) return { light: "GREY", label: "Not measured" };
  const period = f.periodLabel ?? "last month";
  if (f.lockLevel && f.lockLevel !== "OPEN") return { light: "GREEN", label: `${period} closed (${f.lockLevel.replace("_", " ").toLowerCase()})` };
  if ((f.blockingCount ?? 0) > 0) return { light: "RED", label: `${period}: ${f.blockingCount} blocking, ${f.booksPercent}% complete` };
  if (f.booksPercent >= 100 && (f.attentionCount ?? 0) === 0) return { light: "GREEN", label: `${period}: 100% complete` };
  return { light: "AMBER", label: `${period}: ${f.booksPercent}% complete` };
}

export function reconciliationIndicator(f: HealthFacts | null, vis: ViewerVisibility): Indicator {
  if (!vis.reconciliation) return HIDDEN;
  if (!f || f.state !== "OK" || f.unreconciledCount === null) return { light: "GREY", label: "Not measured" };
  const n = f.unreconciledCount;
  const uncat = f.uncategorisedCount ?? 0;
  if (n === 0) return { light: "GREEN", label: "All reconciled" };
  const label = `${n} unreconciled${uncat > 0 ? `, ${uncat} uncategorised` : ""}`;
  return { light: n > RECON_RED_THRESHOLD ? "RED" : "AMBER", label };
}

export function payrollIndicator(f: HealthFacts | null, vis: ViewerVisibility): Indicator {
  if (!vis.payroll) return HIDDEN;
  if (!f || f.state !== "OK" || f.draftPayRuns === null) return { light: "GREY", label: "Not measured" };
  if (f.draftPayRuns === 0) return { light: "GREEN", label: "No draft pay runs" };
  return { light: "AMBER", label: `${f.draftPayRuns} draft pay run${f.draftPayRuns === 1 ? "" : "s"}` };
}

/**
 * BAS / Tax. There is NO BAS lodgement or GST-return feature in this system and
 * no tax-office integration: this indicator reflects only (a) the deadline the
 * PRACTICE entered by hand in its own task list / tax calendar and (b) the
 * client's own tax-lock state. Nothing here is a tax figure or an official due date.
 */
export function taxIndicator(f: HealthFacts | null, d: DeadlineFacts, today: string): Indicator {
  const lock = f?.taxLockedThrough ? ` · tax-locked through ${f.taxLockedThrough}` : "";
  if (!d.nextDueDate) {
    return { light: "GREY", label: `No deadline entered${lock}` };
  }
  const days = daysBetween(today, d.nextDueDate);
  const what = d.nextTitle ? `${d.nextTitle}: ` : "";
  if (days < 0) return { light: "RED", label: `${what}overdue by ${-days} day${days === -1 ? "" : "s"} (${d.nextDueDate})${lock}` };
  if (days <= DEADLINE_AMBER_DAYS) return { light: "AMBER", label: `${what}due ${d.nextDueDate} (${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`})${lock}` };
  return { light: "GREEN", label: `${what}due ${d.nextDueDate}${lock}` };
}

export function deriveRow(f: HealthFacts | null, vis: ViewerVisibility, d: DeadlineFacts, today: string): RowIndicators {
  const books = booksIndicator(f, vis);
  const reconciliation = reconciliationIndicator(f, vis);
  const payroll = payrollIndicator(f, vis);
  const tax = taxIndicator(f, d, today);
  const neverRefreshed = !f;
  const issues =
    (vis.books ? (f?.blockingCount ?? 0) + (f?.attentionCount ?? 0) : 0) + d.overdueTasks;
  const lights = [books.light, reconciliation.light, payroll.light, tax.light];
  const severity = Math.max(...lights.map((l) => RANK[l])) * 10 + lights.reduce((s, l) => s + RANK[l], 0) + (neverRefreshed ? 1 : 0);
  return {
    books,
    reconciliation,
    tax,
    payroll,
    issues,
    severity,
    needsIntervention: lights.some((l) => l === "RED" || l === "AMBER") || d.overdueTasks > 0,
    neverRefreshed,
  };
}

/** Worst first: higher severity, then more issues, then name. */
export function compareByUrgency(
  a: { severity: number; issues: number; name: string },
  b: { severity: number; issues: number; name: string },
): number {
  return b.severity - a.severity || b.issues - a.issues || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------- snapshot age

export function isSnapshotStale(computedAt: Date | string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(computedAt).getTime() > SNAPSHOT_STALE_AFTER_HOURS * 3_600_000;
}

/** "just now", "12 minutes ago", "2 hours ago", "3 days ago" — honest about how old the figures are. */
export function describeSnapshotAge(computedAt: Date | string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(computedAt).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
