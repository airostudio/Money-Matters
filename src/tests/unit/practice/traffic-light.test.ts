import { describe, expect, it } from "vitest";
import {
  DEADLINE_AMBER_DAYS,
  RECON_RED_THRESHOLD,
  booksIndicator,
  compareByUrgency,
  deriveRow,
  describeSnapshotAge,
  isSnapshotStale,
  payrollIndicator,
  reconciliationIndicator,
  taxIndicator,
  type DeadlineFacts,
  type HealthFacts,
  type ViewerVisibility,
} from "@/domain/practice/traffic-light";
import { DASHBOARD_PAGE_SIZE, MAX_BULK_SELECTION, MAX_CLIENTS_PER_PRACTICE, PRACTICE_ROLE_RANK } from "@/domain/practice/types";
import { practiceRoleAtLeast } from "@/domain/practice/practice-access";

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  state: "OK",
  periodLabel: "2026-09",
  lockLevel: "OPEN",
  booksPercent: 100,
  blockingCount: 0,
  attentionCount: 0,
  unreconciledCount: 0,
  uncategorisedCount: 0,
  draftPayRuns: 0,
  taxLockedThrough: null,
  ...over,
});
const all: ViewerVisibility = { books: true, reconciliation: true, payroll: true };
const noDeadline: DeadlineFacts = { nextDueDate: null, nextTitle: null, overdueTasks: 0 };
const TODAY = "2026-10-05";

describe("traffic-light derivation", () => {
  it("Books: RED when anything is blocking, AMBER when incomplete, GREEN when complete or the period is closed", () => {
    expect(booksIndicator(facts({ blockingCount: 1, booksPercent: 40 }), all).light).toBe("RED");
    expect(booksIndicator(facts({ booksPercent: 80 }), all).light).toBe("AMBER");
    expect(booksIndicator(facts({ booksPercent: 100, attentionCount: 2 }), all).light).toBe("AMBER");
    expect(booksIndicator(facts(), all).light).toBe("GREEN");
    expect(booksIndicator(facts({ booksPercent: 50, lockLevel: "SOFT_LOCKED" }), all)).toEqual({ light: "GREEN", label: "2026-09 closed (soft locked)" });
  });

  it("Reconciliation: GREEN at zero, AMBER up to the threshold, RED above it", () => {
    expect(reconciliationIndicator(facts(), all).light).toBe("GREEN");
    expect(reconciliationIndicator(facts({ unreconciledCount: 1, uncategorisedCount: 1 }), all)).toEqual({ light: "AMBER", label: "1 unreconciled, 1 uncategorised" });
    expect(reconciliationIndicator(facts({ unreconciledCount: RECON_RED_THRESHOLD }), all).light).toBe("AMBER");
    expect(reconciliationIndicator(facts({ unreconciledCount: RECON_RED_THRESHOLD + 1 }), all).light).toBe("RED");
  });

  it("Payroll: AMBER with draft pay runs; hidden (GREY, explained) when the VIEWER lacks payrun:read even if the snapshot has the figure", () => {
    expect(payrollIndicator(facts({ draftPayRuns: 2 }), all)).toEqual({ light: "AMBER", label: "2 draft pay runs" });
    expect(payrollIndicator(facts({ draftPayRuns: 0 }), all).light).toBe("GREEN");
    expect(payrollIndicator(facts({ draftPayRuns: 2 }), { ...all, payroll: false })).toEqual({ light: "GREY", label: "Not visible to your role" });
    expect(payrollIndicator(facts({ draftPayRuns: null }), all).label).toBe("Not measured");
  });

  it("Books and Reconciliation are likewise hidden by the viewer's own role", () => {
    expect(booksIndicator(facts(), { ...all, books: false }).label).toBe("Not visible to your role");
    expect(reconciliationIndicator(facts({ unreconciledCount: 99 }), { ...all, reconciliation: false }).label).toBe("Not visible to your role");
  });

  it("BAS/Tax shows only what the practice entered: overdue RED, within the window AMBER, later GREEN, none GREY — and states the tax lock", () => {
    expect(taxIndicator(facts(), noDeadline, TODAY)).toEqual({ light: "GREY", label: "No deadline entered" });
    expect(taxIndicator(facts(), { nextDueDate: "2026-10-01", nextTitle: "BAS", overdueTasks: 1 }, TODAY).light).toBe("RED");
    expect(taxIndicator(facts(), { nextDueDate: TODAY, nextTitle: null, overdueTasks: 0 }, TODAY).label).toContain("today");
    const amber = taxIndicator(facts(), { nextDueDate: "2026-10-12", nextTitle: "BAS", overdueTasks: 0 }, TODAY);
    expect(amber.light).toBe("AMBER");
    expect(DEADLINE_AMBER_DAYS).toBe(7);
    expect(taxIndicator(facts(), { nextDueDate: "2026-10-13", nextTitle: "BAS", overdueTasks: 0 }, TODAY).light).toBe("GREEN");
    expect(taxIndicator(facts({ taxLockedThrough: "2026-06-30" }), { nextDueDate: "2026-12-01", nextTitle: null, overdueTasks: 0 }, TODAY).label).toContain("tax-locked through 2026-06-30");
  });

  it("deriveRow: issues aggregate blocking + attention + overdue tasks; severity orders worst first; never-refreshed floats above healthy", () => {
    const healthy = deriveRow(facts(), all, noDeadline, TODAY);
    const amber = deriveRow(facts({ unreconciledCount: 3 }), all, noDeadline, TODAY);
    const red = deriveRow(facts({ blockingCount: 2, attentionCount: 1, booksPercent: 30 }), all, { ...noDeadline, overdueTasks: 2 }, TODAY);
    const never = deriveRow(null, all, noDeadline, TODAY);
    expect(healthy.needsIntervention).toBe(false);
    expect(healthy.issues).toBe(0);
    expect(amber.needsIntervention).toBe(true);
    expect(red.issues).toBe(2 + 1 + 2);
    expect(red.severity).toBeGreaterThan(amber.severity);
    expect(amber.severity).toBeGreaterThan(never.severity);
    expect(never.severity).toBeGreaterThan(healthy.severity);
    expect(never.neverRefreshed).toBe(true);

    const rows = [
      { name: "B", ...healthy },
      { name: "A", ...red },
      { name: "C", ...amber },
      { name: "D", ...never },
    ].sort(compareByUrgency);
    expect(rows.map((r) => r.name)).toEqual(["A", "C", "D", "B"]);
  });

  it("an overdue practice task makes the row need intervention even if every measured indicator is green", () => {
    expect(deriveRow(facts(), all, { ...noDeadline, overdueTasks: 1 }, TODAY).needsIntervention).toBe(true);
  });

  it("when the viewer cannot see books, the blocking/attention counts do not leak into the issues figure", () => {
    const row = deriveRow(facts({ blockingCount: 5, attentionCount: 5 }), { ...all, books: false }, noDeadline, TODAY);
    expect(row.issues).toBe(0);
  });

  it("equal urgency falls back to name order (stable, predictable)", () => {
    const a = deriveRow(facts(), all, noDeadline, TODAY);
    expect(compareByUrgency({ ...a, name: "Alpha" }, { ...a, name: "Beta" })).toBeLessThan(0);
  });
});

describe("snapshot age and staleness", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  it("describes the age plainly", () => {
    expect(describeSnapshotAge("2026-10-05T11:59:40Z", now)).toBe("just now");
    expect(describeSnapshotAge("2026-10-05T11:59:00Z", now)).toBe("1 minute ago");
    expect(describeSnapshotAge("2026-10-05T11:30:00Z", now)).toBe("30 minutes ago");
    expect(describeSnapshotAge("2026-10-05T10:00:00Z", now)).toBe("2 hours ago");
    expect(describeSnapshotAge("2026-10-02T12:00:00Z", now)).toBe("3 days ago");
  });
  it("is stale after 24 hours, not before", () => {
    expect(isSnapshotStale("2026-10-04T12:00:01Z", now)).toBe(false);
    expect(isSnapshotStale("2026-10-04T11:59:59Z", now)).toBe(true);
  });
});

describe("bounded-page and role-rank logic", () => {
  it("the dashboard page and the bulk selection are the same bounded size, well under the pool cap, and the client cap is documented", () => {
    expect(DASHBOARD_PAGE_SIZE).toBe(10);
    expect(MAX_BULK_SELECTION).toBe(DASHBOARD_PAGE_SIZE);
    expect(MAX_CLIENTS_PER_PRACTICE).toBeGreaterThanOrEqual(DASHBOARD_PAGE_SIZE);
  });
  it("practice roles rank STAFF < MANAGER < PARTNER", () => {
    expect(PRACTICE_ROLE_RANK).toEqual({ STAFF: 1, MANAGER: 2, PARTNER: 3 });
    expect(practiceRoleAtLeast("PARTNER", "MANAGER")).toBe(true);
    expect(practiceRoleAtLeast("MANAGER", "MANAGER")).toBe(true);
    expect(practiceRoleAtLeast("STAFF", "MANAGER")).toBe(false);
  });
});
