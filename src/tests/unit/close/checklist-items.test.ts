import { describe, expect, it } from "vitest";
import {
  MANUAL_CHECKS,
  balanceSheetItem,
  bankingItems,
  classifyItems,
  computeProgress,
  depreciationItem,
  draftDocumentItem,
  draftJournalsItem,
  manualItems,
  priorPeriodItem,
  reconciliationItem,
  suspenseItem,
  trialBalanceItem,
} from "@/domain/close/checklist-items";
import type { ChecklistItem, SignoffInfo } from "@/domain/close/checklist-types";
import { buildChecklist } from "@/domain/close/checklist-service";
import { checklistFacts } from "@/domain/close/checklist-summary";
import {
  dayBefore,
  endOfDayUtc,
  isCalendarMonth,
  monthBounds,
  monthKey,
  parsePeriodRef,
  previousMonth,
  InvalidPeriodRefError,
} from "@/domain/close/period-ref";

const signoff: SignoffInfo = { signedById: "u1", signedByName: "Ada", signedAt: "2026-09-30T10:00:00.000Z", note: null };

describe("banking check", () => {
  it("is not applicable without bank accounts", () => {
    const [i] = bankingItems([]);
    expect(i).toMatchObject({ id: "bank.none", status: "NOT_APPLICABLE" });
  });

  it("one item per account: passes at zero, needs attention otherwise, with the plain-language detail", () => {
    const items = bankingItems([
      { bankAccountId: "a", name: "Everyday Account", unmatchedCount: 3, ruleSuggestedCount: 1, unmatchedAbsAmount: "123.45" },
      { bankAccountId: "b", name: "Savings", unmatchedCount: 0, ruleSuggestedCount: 0, unmatchedAbsAmount: "0.00" },
    ]);
    expect(items[0]).toMatchObject({ status: "ATTENTION", count: 3, amount: "123.45", href: "/money/a", kind: "AUTOMATIC", verifiedBy: null });
    expect(items[0]!.detail).toContain("3 bank transactions in Everyday Account are unreconciled");
    expect(items[0]!.detail).toContain("1 has a rule-suggested category");
    expect(items[1]).toMatchObject({ status: "PASSED", verifiedBy: "SYSTEM", count: 0 });
    expect(bankingItems([{ bankAccountId: "c", name: "Card", unmatchedCount: 1, ruleSuggestedCount: 0, unmatchedAbsAmount: "5.00" }])[0]!.detail).toContain("1 bank transaction in Card is unreconciled");
  });
});

describe("draft document checks", () => {
  const base = { id: "sales.draft_invoices", title: "Draft invoices", category: "SALES" as const, noun: "draft invoice", href: "/sales/invoices?status=DRAFT", qualifier: "dated in this period" };
  it("passes with none, needs attention with some (singular/plural, amount)", () => {
    expect(draftDocumentItem({ ...base, count: 0, amount: null })).toMatchObject({ status: "PASSED", verifiedBy: "SYSTEM" });
    const one = draftDocumentItem({ ...base, count: 1, amount: "50.00" });
    expect(one).toMatchObject({ status: "ATTENTION", count: 1, amount: "50.00" });
    expect(one.detail).toContain("1 draft invoice dated in this period, totalling 50.00");
    expect(draftDocumentItem({ ...base, count: 4, amount: null }).detail).toContain("4 draft invoices");
  });
});

describe("depreciation check", () => {
  it("not applicable without eligible assets; passes when none missing; attention when some are", () => {
    expect(depreciationItem({ eligibleAssets: 0, missingAssets: 0, monthLabel: "2026-09" }).status).toBe("NOT_APPLICABLE");
    expect(depreciationItem({ eligibleAssets: 2, missingAssets: 0, monthLabel: "2026-09" }).status).toBe("PASSED");
    const a = depreciationItem({ eligibleAssets: 3, missingAssets: 2, monthLabel: "2026-09" });
    expect(a).toMatchObject({ status: "ATTENTION", count: 2 });
    expect(a.detail).toContain("not been run for 2026-09 for 2 of 3 active assets");
  });
});

describe("reconciliation checks (register / inventory vs the ledger)", () => {
  const m = {
    id: "assets.register_reconciles",
    title: "Register reconciles",
    category: "ASSETS" as const,
    href: "/fixed-assets",
    notApplicableDetail: "none",
    passedDetail: "ok",
  };
  it("N/A, passed, or BLOCKING listing the accounts and differences", () => {
    expect(reconciliationItem({ ...m, applicable: false, mismatches: [] }).status).toBe("NOT_APPLICABLE");
    expect(reconciliationItem({ ...m, applicable: true, mismatches: [] }).status).toBe("PASSED");
    const b = reconciliationItem({ ...m, applicable: true, mismatches: [{ name: "FA-01 Vehicles", difference: "12000.0000" }] });
    expect(b.status).toBe("BLOCKING");
    expect(b.detail).toContain("FA-01 Vehicles (difference 12000.0000)");
  });
});

describe("ledger integrity checks", () => {
  it("trial balance: equal passes, unequal BLOCKS with the difference", () => {
    expect(trialBalanceItem({ totalDebit: "100.00", totalCredit: "100.00", asOf: "2026-09-30" }).status).toBe("PASSED");
    const bad = trialBalanceItem({ totalDebit: "100.00", totalCredit: "99.00", asOf: "2026-09-30" });
    expect(bad).toMatchObject({ status: "BLOCKING", amount: "1.00" });
  });

  it("balance sheet equation", () => {
    expect(balanceSheetItem({ balanced: true, assets: "10", liabilitiesAndEquity: "10", difference: "0", asOf: "2026-09-30" }).status).toBe("PASSED");
    expect(balanceSheetItem({ balanced: false, assets: "10", liabilitiesAndEquity: "9", difference: "1", asOf: "2026-09-30" }).status).toBe("BLOCKING");
  });

  it("suspense/clearing: honest N/A when the chart has none, attention for a non-zero balance, passed when all zero", () => {
    const na = suspenseItem([]);
    expect(na.status).toBe("NOT_APPLICABLE");
    expect(na.detail).toMatch(/does not create any by default/);
    expect(suspenseItem([{ accountId: "x", code: "1999", name: "Clearing", balance: "0.00" }]).status).toBe("PASSED");
    const a = suspenseItem([
      { accountId: "x", code: "1999", name: "Clearing", balance: "0.00" },
      { accountId: "y", code: "1998", name: "Suspense", balance: "-25.50" },
    ]);
    expect(a).toMatchObject({ status: "ATTENTION", count: 1, amount: "25.50" });
    expect(a.detail).toContain("1998 Suspense (-25.50)");
  });

  it("draft journals", () => {
    expect(draftJournalsItem({ count: 0 }).status).toBe("PASSED");
    expect(draftJournalsItem({ count: 2 })).toMatchObject({ status: "ATTENTION", count: 2 });
  });

  it("sequencing warns (never blocks) when the previous period is unlocked", () => {
    expect(priorPeriodItem({ previous: null }).status).toBe("NOT_APPLICABLE");
    expect(priorPeriodItem({ previous: { label: "2026-08", locked: true } }).status).toBe("PASSED");
    const w = priorPeriodItem({ previous: { label: "2026-08", locked: false } });
    expect(w.status).toBe("ATTENTION");
    expect(w.status).not.toBe("BLOCKING");
  });
});

describe("manual sign-off items", () => {
  const ctx = (over: Partial<Parameters<typeof manualItems>[0]> = {}) => ({
    fxLineCount: 0,
    baseCurrency: "AUD",
    budgetCount: 1,
    canSeeBudgets: true,
    from: "2026-09-01",
    to: "2026-09-30",
    signoffs: new Map<string, SignoffInfo>(),
    ...over,
  });

  it("unsigned items are MANUAL (never PASSED), signed ones are PASSED but attributed to a HUMAN", () => {
    const { items } = manualItems(ctx({ signoffs: new Map([["manual.accruals", signoff]]) }));
    const accruals = items.find((i) => i.id === "manual.accruals")!;
    expect(accruals).toMatchObject({ kind: "MANUAL", status: "PASSED", verifiedBy: "HUMAN" });
    expect(accruals.signoff).toEqual(signoff);
    const prepayments = items.find((i) => i.id === "manual.prepayments")!;
    expect(prepayments).toMatchObject({ kind: "MANUAL", status: "MANUAL", verifiedBy: null, signoff: null });
    // No manual item is ever system-verified.
    expect(items.every((i) => i.kind === "MANUAL" && i.verifiedBy !== "SYSTEM")).toBe(true);
  });

  it("covers every item the spec lists and links reviews to the period", () => {
    const { items } = manualItems(ctx({ fxLineCount: 2 }));
    expect(items.map((i) => i.id).sort()).toEqual(MANUAL_CHECKS.map((c) => c.key).sort());
    expect(items.find((i) => i.id === "manual.pnl_review")!.href).toBe("/accounting/reports/profit-and-loss?from=2026-09-01&to=2026-09-30");
  });

  it("foreign exchange is N/A without foreign lines; budget variance is N/A with no budget and hidden without budget:read; intercompany is always N/A", () => {
    const { items } = manualItems(ctx({ fxLineCount: 0, budgetCount: 0 }));
    expect(items.find((i) => i.id === "manual.foreign_exchange")!.status).toBe("NOT_APPLICABLE");
    expect(items.find((i) => i.id === "manual.budget_variance")!.status).toBe("NOT_APPLICABLE");
    expect(items.find((i) => i.id === "manual.intercompany")!.status).toBe("NOT_APPLICABLE");
    const withFx = manualItems(ctx({ fxLineCount: 3 })).items.find((i) => i.id === "manual.foreign_exchange")!;
    expect(withFx.status).toBe("MANUAL");
    expect(withFx.detail).toContain("not automated");

    const hidden = manualItems(ctx({ canSeeBudgets: false }));
    expect(hidden.items.find((i) => i.id === "manual.budget_variance")).toBeUndefined();
    expect(hidden.hiddenCount).toBe(1);
  });
});

describe("progress percentage", () => {
  const mk = (status: ChecklistItem["status"], kind: ChecklistItem["kind"] = "AUTOMATIC"): ChecklistItem => ({
    id: Math.random().toString(),
    title: "t",
    category: "LEDGER",
    kind,
    status,
    verifiedBy: status === "PASSED" ? (kind === "MANUAL" ? "HUMAN" : "SYSTEM") : null,
    detail: "",
    href: null,
    count: null,
    amount: null,
    signoff: null,
  });

  it("= PASSED (system or human) / applicable, excluding NOT_APPLICABLE", () => {
    const items = [mk("PASSED"), mk("PASSED", "MANUAL"), mk("ATTENTION"), mk("BLOCKING"), mk("MANUAL", "MANUAL"), mk("NOT_APPLICABLE"), mk("NOT_APPLICABLE")];
    const p = computeProgress(items);
    expect(p).toMatchObject({ complete: 2, applicable: 5, percent: 40 });
    expect(p.formula).toMatch(/applicable/);
  });

  it("rounds, and is 100 when nothing is applicable (no divide by zero)", () => {
    expect(computeProgress([mk("PASSED"), mk("PASSED"), mk("ATTENTION")]).percent).toBe(67);
    expect(computeProgress([mk("NOT_APPLICABLE")]).percent).toBe(100);
    expect(computeProgress([]).percent).toBe(100);
  });

  it("classification: remaining excludes passed and N/A; outstanding is attention + unsigned manual; blocking separate", () => {
    const items = [mk("PASSED"), mk("ATTENTION"), mk("BLOCKING"), mk("MANUAL", "MANUAL"), mk("NOT_APPLICABLE")];
    const c = classifyItems(items);
    expect(c.remaining).toHaveLength(3);
    expect(c.blocking).toHaveLength(1);
    expect(c.outstanding.map((i) => i.status).sort()).toEqual(["ATTENTION", "MANUAL"]);
  });

  it("buildChecklist assembles progress and the remaining list; the AI facts keep system-verified and human-signed separate", () => {
    const period = { id: null, key: "2026-09", label: "2026-09", start: new Date("2026-09-01Z"), end: new Date("2026-09-30Z"), lockLevel: "OPEN" as const, row: null };
    const items = [
      mk("PASSED"),
      { ...mk("PASSED", "MANUAL"), title: "Accruals reviewed", signoff },
      { ...mk("ATTENTION"), title: "Bank", detail: "3 bank transactions are unreconciled." },
    ];
    const c = buildChecklist(period, items, 1);
    expect(c.progress.percent).toBe(67);
    expect(c.remaining).toHaveLength(1);
    expect(c.hiddenCount).toBe(1);
    const facts = checklistFacts(c).join("\n");
    expect(facts).toContain("67% complete");
    expect(facts).toContain("SIGNED OFF BY A PERSON (not system-verified): Accruals reviewed by Ada");
    expect(facts).toContain("VERIFIED BY THE SYSTEM from live data");
    expect(facts).toContain("3 bank transactions are unreconciled.");
    expect(facts).toContain("hidden from this user's role");
  });
});

describe("period references", () => {
  it("parses month keys and ids, rejects junk", () => {
    expect(parsePeriodRef("2026-09")).toEqual({ kind: "month", year: 2026, month: 9 });
    expect(parsePeriodRef("0b6d3a2e-4c7e-4f4c-8b0a-1d2e3f4a5b6c")).toMatchObject({ kind: "id" });
    for (const bad of ["2026-13", "2026-9", "september", "", "2026-09-01"]) expect(() => parsePeriodRef(bad)).toThrow(InvalidPeriodRefError);
  });

  it("month bounds follow the existing end-at-midnight-of-last-day convention, with an end-of-day helper", () => {
    const { start, end } = monthBounds(2026, 2);
    expect(start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(endOfDayUtc(end).toISOString()).toBe("2026-02-28T23:59:59.999Z");
    expect(isCalendarMonth(start, end)).toBe(true);
    expect(isCalendarMonth(start, new Date("2026-02-27Z"))).toBe(false);
    expect(monthKey(2026, 2)).toBe("2026-02");
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(dayBefore(start).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});
