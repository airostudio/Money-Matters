import { describe, expect, it } from "vitest";
import {
  InvalidAmountError,
  compareSnapshotToLedger,
  evaluateReviewerSignoff,
  parseAmount,
  planCarryForward,
  reconcile,
  suggestNextPeriodEnd,
  type ScheduleLine,
} from "@/domain/practice/workpaper-math";

const line = (over: Partial<ScheduleLine> & { amount: string }): ScheduleLine => ({
  kind: "RECONCILING_ITEM",
  description: "x",
  ...over,
});

describe("reconciliation difference — exact decimal arithmetic", () => {
  it("ledger 12,000.00 = statement 12,450.00 + outstanding items -450.00 -> difference 0.00", () => {
    const result = reconcile("12000.00", [
      line({ kind: "SUPPORTING_BALANCE", description: "Bank statement balance", amount: "12450.00" }),
      line({ description: "Outstanding cheques", amount: "-450.00" }),
    ]);
    expect(result).toEqual({ ledgerBalance: "12000.00", scheduleTotal: "12000.00", difference: "0.00", isReconciled: true });
  });

  it("a 100.00 discrepancy: items of -350.00 leave the schedule at 12,100.00, so the ledger is 100.00 LOWER than it supports", () => {
    const result = reconcile("12000.00", [
      line({ kind: "SUPPORTING_BALANCE", amount: "12450.00" }),
      line({ amount: "-350.00" }),
    ]);
    expect(result.scheduleTotal).toBe("12100.00");
    expect(result.difference).toBe("-100.00");
    expect(result.isReconciled).toBe(false);
  });

  it("is exact where floats are not: 0.1 + 0.2 reconciles to 0.3 with no residue", () => {
    expect(reconcile("0.30", [line({ amount: "0.1" }), line({ amount: "0.2" })]).difference).toBe("0.00");
    expect(reconcile("1000000.10", [line({ amount: "999999.9" }), line({ amount: "0.2" })]).isReconciled).toBe(true);
  });

  it("handles four decimal places and shows a sub-cent residue instead of rounding it away", () => {
    const r = reconcile("10.0000", [line({ amount: "9.9999" })]);
    expect(r.difference).toBe("0.0001"); // a sub-cent residue is never displayed as 0.00 ...
    expect(r.isReconciled).toBe(false); // ... and the test is on the exact value
  });

  it("an empty schedule reconciles only a zero ledger balance", () => {
    expect(reconcile("0", []).isReconciled).toBe(true);
    expect(reconcile("5.00", []).difference).toBe("5.00");
  });

  it("rejects anything that is not a plain decimal (no exponent, no float noise, no text)", () => {
    for (const bad of ["1e3", "12,45a", "", "NaN", "1.23456", "--5", "0x10"]) {
      expect(() => parseAmount(bad), bad).toThrow(InvalidAmountError);
    }
    expect(parseAmount("1,234.50").toFixed(2)).toBe("1234.50");
  });
});

describe("snapshot staleness", () => {
  it("is stale on ANY change, with the exact change", () => {
    expect(compareSnapshotToLedger("12000.00", "12000.00")).toEqual({ stale: false, change: "0.00" });
    expect(compareSnapshotToLedger("12000.00", "12150.25")).toEqual({ stale: true, change: "150.25" });
    expect(compareSnapshotToLedger("12000.00", "11999.99")).toEqual({ stale: true, change: "-0.01" });
  });
});

describe("carry-forward copy rules", () => {
  const source = {
    periodEnd: "2026-09-30",
    ledgerBalance: "12000.0000",
    lines: [
      line({ kind: "SUPPORTING_BALANCE", description: "Bank statement balance", reference: "Everyday acct", amount: "12450.00" }),
      line({ description: "Unpresented cheque 1043", amount: "-450.00" }),
      line({ description: "Bank fee accrual (monthly)", amount: "-12.50", isRecurring: true }),
    ],
  };

  it("keeps the structure with supporting balances ZEROED, copies RECURRING items with amounts, drops the rest", () => {
    const plan = planCarryForward(source);
    expect(plan.lines).toEqual([
      { kind: "SUPPORTING_BALANCE", description: "Bank statement balance", reference: "Everyday acct", amount: "0.0000", isRecurring: false },
      { kind: "RECONCILING_ITEM", description: "Bank fee accrual (monthly)", reference: null, amount: "-12.5000", isRecurring: true },
    ]);
    expect(plan.disposition.map((d) => d.outcome)).toEqual(["STRUCTURE_ONLY_ZEROED", "DROPPED", "COPIED_RECURRING"]);
  });

  it("carries the prior balance and date as the comparative", () => {
    const plan = planCarryForward(source);
    expect(plan.priorPeriodEnd).toBe("2026-09-30");
    expect(plan.priorLedgerBalance).toBe("12000.0000");
  });

  it("the plan has no field for evidence, sign-offs, notes, adjustments or the snapshot — nothing of the kind can be carried", () => {
    const plan = planCarryForward(source);
    expect(Object.keys(plan).sort()).toEqual(["disposition", "lines", "priorLedgerBalance", "priorPeriodEnd"]);
  });

  it("suggests the last day of the following month", () => {
    expect(suggestNextPeriodEnd("2026-09-30")).toBe("2026-10-31");
    expect(suggestNextPeriodEnd("2026-12-31")).toBe("2027-01-31");
    expect(suggestNextPeriodEnd("2027-01-31")).toBe("2027-02-28");
    expect(suggestNextPeriodEnd("2028-01-31")).toBe("2028-02-29");
  });
});

describe("segregation of duties for the reviewer sign-off", () => {
  it("a different person may review", () => {
    expect(evaluateReviewerSignoff({ preparerUserId: "p", signerUserId: "q", activeStaffCount: 3 })).toEqual({ allowed: true, singleStaffException: false });
  });
  it("the preparer may NOT review their own work when the practice has two or more active staff", () => {
    const r = evaluateReviewerSignoff({ preparerUserId: "p", signerUserId: "p", activeStaffCount: 2 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/different person/);
  });
  it("a single-staff practice may — flagged as the documented exception", () => {
    expect(evaluateReviewerSignoff({ preparerUserId: "p", signerUserId: "p", activeStaffCount: 1 })).toEqual({ allowed: true, singleStaffException: true });
  });
});
