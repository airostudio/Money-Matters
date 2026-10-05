import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedForecastData, type ForecastSeed } from "../../helpers/forecast-fixtures";
import { CashForecastService } from "@/domain/forecasting/cash-forecast-service";
import { ForecastSettingsService } from "@/domain/forecasting/forecast-settings-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import type { ForecastLine, KnownForecastLine, StatisticalForecastLine } from "@/domain/forecasting/types";

const ASOF = D("2026-10-05");

describe("Cash forecast (Phase 9 Slice 2) — seeded realistic data, hand-verified", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let seed: ForecastSeed;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("cash-forecast");
    owner = org.owner;
    currency = org.baseCurrency;
    seed = await seedForecastData(owner, currency);
  });

  const lineByLabel = (lines: ForecastLine[], needle: string, kind: "KNOWN" | "STATISTICAL") =>
    lines.find((l) => l.kind === kind && l.label.includes(needle));

  it("opening cash is the bank account's ledger balance: 8,000 opening + 2,000 received = 10,000", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    expect(f.openingCash.total).toBe("10000.0000");
    expect(f.openingCash.accounts).toHaveLength(1);
    expect(f.currency).toBe(currency);
  });

  it("classifies every line as KNOWN or STATISTICAL with the right source and timing", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });

    // KNOWN: C at its due date; D overdue and undated; E at its due date; no-history customer has no statistical twin.
    const c = lineByLabel(f.lines, "INV-", "KNOWN") as KnownForecastLine;
    expect(c).toBeDefined();
    const knownInflows = f.lines.filter((l): l is KnownForecastLine => l.kind === "KNOWN" && l.direction === "IN");
    const byAmount = (a: string) => knownInflows.find((l) => l.amount === a)!;
    expect(byAmount("3000.0000")).toMatchObject({ date: "2026-10-09", timing: "STATED_DUE_DATE", category: "CUSTOMER_INVOICE" });
    expect(byAmount("2000.0000")).toMatchObject({ date: null, timing: "OVERDUE_RECEIPT_UNDATED", statedDate: "2026-09-25" });
    expect(byAmount("1500.0000")).toMatchObject({ date: "2026-10-20", timing: "STATED_DUE_DATE" });
    expect(byAmount("700.0000")).toMatchObject({ date: null, timing: "OVERDUE_RECEIPT_UNDATED" });

    // STATISTICAL: Acme's invoices shifted by their 12-day average lateness (2 settled invoices); Fresh Co has none.
    const stats = f.lines.filter((l): l is StatisticalForecastLine => l.kind === "STATISTICAL" && l.category === "CUSTOMER_INVOICE");
    expect(stats).toHaveLength(2);
    const sC = stats.find((l) => l.amount === "3000.0000")!;
    expect(sC.date).toBe("2026-10-21"); // due Friday 10-09 + 12 days = Wednesday 10-21
    expect(sC.basis).toEqual({ type: "CUSTOMER_AVG_DAYS_LATE", avgDaysLate: 12, settledInvoiceCount: 2 });
    expect(sC.replacesLineId).toBe(byAmount("3000.0000").id);
    const sD = stats.find((l) => l.amount === "2000.0000")!;
    expect(sD.date).toBe("2026-10-07"); // overdue 09-25 + 12 = 10-07
    expect(stats.some((l) => l.amount === "1500.0000" || l.amount === "700.0000")).toBe(false);

    // Bills: BILL-1 at its due date, BILL-2 overdue → today, BILL-3 re-dated to its approved payment run (ONE line, not two).
    const outs = f.lines.filter((l): l is KnownForecastLine => l.kind === "KNOWN" && l.direction === "OUT" && l.category !== "PAYROLL_LIABILITY");
    expect(outs.find((l) => l.amount === "4000.0000")).toMatchObject({ date: "2026-10-12", category: "SUPPLIER_BILL" });
    expect(outs.find((l) => l.amount === "500.0000")).toMatchObject({ date: "2026-10-05", timing: "OVERDUE_ASSUMED_DUE_NOW" });
    const runLines = outs.filter((l) => l.amount === "6000.0000");
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toMatchObject({ date: "2026-10-15", category: "PAYMENT_RUN", timing: "SCHEDULED_PAYMENT_RUN" });
    expect(runLines[0]!.source).toMatchObject({ type: "PAYMENT_RUN", id: seed.paymentRunId });

    // Recurring bill (backlog from 10-01 → cash 10-31) is KNOWN scheduled; recurring invoice (10-10 → cash 11-09) is outside 30D.
    expect(outs.find((l) => l.category === "RECURRING_BILL")).toMatchObject({ date: "2026-10-31", timing: "TEMPLATE_SCHEDULE" });
    expect(f.lines.some((l) => l.category === "RECURRING_INVOICE")).toBe(false);

    // Payroll: three KNOWN-amount liabilities, timing UNVERIFIED, no dates; plus STATISTICAL projected net wages.
    const payrollKnown = f.lines.filter((l): l is KnownForecastLine => l.kind === "KNOWN" && l.category === "PAYROLL_LIABILITY");
    expect(payrollKnown.map((l) => l.amount).sort()).toEqual(["3084.6154", "480.0000", "915.3846"].sort());
    expect(payrollKnown.every((l) => l.timing === "UNVERIFIED" && l.date === null)).toBe(true);
    const payrollStat = f.lines.filter((l) => l.kind === "STATISTICAL" && l.category === "PAYROLL_PROJECTION");
    expect(payrollStat.map((l) => l.date)).toEqual(["2026-10-16", "2026-10-30"]);
  });

  it("30D: the KNOWN-only series, the including-statistical series and the low points match the hand calculation", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    const at = (series: typeof f.knownOnly, date: string) => series.points.find((p) => p.date === date)!.balance;

    expect(f.granularity).toBe("DAILY");
    expect(f.knownOnly.points).toHaveLength(31);

    // Known-only: 10,000 −500 (BILL-2, today) = 9,500; +3,000 (10-09) = 12,500; −4,000 (10-12) = 8,500;
    // −6,000 (10-15, payment run) = 2,500; +1,500 (10-20) = 4,000; −900 (10-31, rent) = 3,100.
    expect(at(f.knownOnly, "2026-10-05")).toBe("9500.0000");
    expect(at(f.knownOnly, "2026-10-09")).toBe("12500.0000");
    expect(at(f.knownOnly, "2026-10-12")).toBe("8500.0000");
    expect(at(f.knownOnly, "2026-10-15")).toBe("2500.0000");
    expect(at(f.knownOnly, "2026-10-20")).toBe("4000.0000");
    expect(f.knownOnly.endBalance).toBe("3100.0000");
    expect(f.knownOnly.lowPoint).toEqual({ date: "2026-10-15", balance: "2500.0000" });
    expect(f.knownOnly.totalIn).toBe("4500.0000");
    expect(f.knownOnly.totalOut).toBe("11400.0000");

    // Including statistical: Acme C moves 10-09 → 10-21, Acme D (overdue, undated) lands 10-07, projected net wages
    // of 3,084.6154 leave on 10-16 and 10-30.
    // 9,500 → +2,000 (10-07) 11,500 → −4,000 (10-12) 7,500 → −6,000 (10-15) 1,500 → −3,084.6154 (10-16) −1,584.6154
    // → +1,500 (10-20) −84.6154 → +3,000 (10-21) 2,915.3846 → −3,084.6154 (10-30) −169.2308 → −900 (10-31) −1,069.2308.
    expect(at(f.withStatistical, "2026-10-07")).toBe("11500.0000");
    expect(at(f.withStatistical, "2026-10-09")).toBe("11500.0000"); // C is NOT received on its due date in this series
    expect(at(f.withStatistical, "2026-10-16")).toBe("-1584.6154");
    expect(at(f.withStatistical, "2026-10-21")).toBe("2915.3846");
    expect(f.withStatistical.endBalance).toBe("-1069.2308");
    expect(f.withStatistical.lowPoint).toEqual({ date: "2026-10-16", balance: "-1584.6154" });

    // The two series are genuinely different numbers — never blended.
    expect(f.knownOnly.endBalance).not.toBe(f.withStatistical.endBalance);

    // Known amounts with no determinable date stay off both timelines: overdue receivables 2,000 + 700; payroll 4,480.
    expect(f.unscheduledKnown.inflows).toBe("2700.0000");
    expect(f.unscheduledKnown.outflows).toBe("4480.0000");
    expect(f.unscheduledKnown.lowPointIfUnscheduledOutflowsPaidNow).toBe("-1980.0000"); // 2,500 − 4,480
  });

  it("low-cash warning: default threshold 0 → only the statistical series breaches, on 2026-10-16, and says so", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    expect(f.lowCashThreshold).toBe("0.0000");
    expect(f.warning.knownOnly).toBeNull();
    expect(f.warning.withStatistical).toEqual({ date: "2026-10-16", daysFromNow: 11, balance: "-1584.6154" });
    expect(f.warning.firstBreach?.series).toBe("INCLUDING_STATISTICAL");
    expect(f.warning.message).toContain("including-statistical");
    expect(f.warning.message).not.toContain("known-commitments-only");
    expect(f.warning.message).toContain("2026-10-16");
  });

  it("a user-configured threshold changes the warning (audited, permission-gated)", async () => {
    await ForecastSettingsService.setLowCashThreshold(owner, "3000.00");
    expect((await ForecastSettingsService.get(owner)).lowCashThreshold).toBe("3000.0000");

    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    expect(f.lowCashThreshold).toBe("3000.0000");
    // Known-only first dips below 3,000 on 10-15 (2,500); including-statistical on 10-15 as well (1,500).
    expect(f.warning.knownOnly).toEqual({ date: "2026-10-15", daysFromNow: 10, balance: "2500.0000" });
    expect(f.warning.withStatistical?.date).toBe("2026-10-15");
    expect(f.warning.firstBreach?.series).toBe("KNOWN_ONLY");

    const manager = actorWithRole(owner, "MANAGER");
    await expect(ForecastSettingsService.setLowCashThreshold(manager, "1")).rejects.toThrow(PermissionDeniedError);
    await expect(ForecastSettingsService.setLowCashThreshold(owner, "-5")).rejects.toThrow(/negative/);
    await expect(ForecastSettingsService.setLowCashThreshold(owner, "abc")).rejects.toThrow(/number/);
  });

  it("7D and 60D horizons", async () => {
    const f7 = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "7D" });
    // Known: −500, +3,000, −4,000 → 8,500. Statistical: −500, +2,000 (D on 10-07), −4,000 → 7,500.
    expect(f7.knownOnly.points).toHaveLength(8);
    expect(f7.knownOnly.endBalance).toBe("8500.0000");
    expect(f7.withStatistical.endBalance).toBe("7500.0000");

    const f60 = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "60D" });
    // Known adds the recurring invoice (+1,200 on 11-09) and the 12-01 rent (−900): 3,100 + 1,200 − 900 = 3,400.
    expect(f60.knownOnly.endBalance).toBe("3400.0000");
    expect(f60.knownOnly.lowPoint).toEqual({ date: "2026-10-15", balance: "2500.0000" });
    // Statistical: −1,069.2308 + 1,200 − 3,084.6154 (11-13) − 3,084.6154 (11-27) − 900 = −6,938.4616.
    expect(f60.withStatistical.endBalance).toBe("-6938.4616");
    expect(f60.withStatistical.lowPoint).toEqual({ date: "2026-12-01", balance: "-6938.4616" });
  });

  it("12M horizon is weekly for display but the low point is still day-exact", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "12M" });
    expect(f.granularity).toBe("WEEKLY");
    expect(f.horizonDays).toBe(365);
    expect(f.knownOnly.points.length).toBe(54);
    expect(f.knownOnly.points[0]!.date).toBe("2026-10-05");
    expect(f.knownOnly.points.at(-1)!.date).toBe("2027-10-05");
    // Rent recurs monthly out to the horizon, the retainer in: the low point is on a real flow date.
    expect(f.knownOnly.lowPoint.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("an AWAITING_APPROVAL payment run is a proposal: the bill stays at its due date and only gains a note", async () => {
    await resetDatabase();
    const org = await createTestOrg("cash-forecast-awaiting");
    const localSeed = await seedForecastData(org.owner, org.baseCurrency, { paymentRunStatus: "AWAITING_APPROVAL" });
    const f = await CashForecastService.generate(org.owner, { asOfDate: ASOF, horizon: "60D" });
    const line = f.lines.find((l) => l.amount === "6000.0000" && l.kind === "KNOWN") as KnownForecastLine;
    expect(line.category).toBe("SUPPLIER_BILL");
    expect(line.date).toBe("2026-10-31"); // its own due date, not the run's 10-15
    expect(line.note).toContain("awaiting approval");
    expect(localSeed.paymentRunId).toBeTruthy();
  });

  it("freshness: newly posted data changes the next forecast (nothing is cached)", async () => {
    const before = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    expect(before.openingCash.total).toBe("10000.0000");

    // Acme finally pays invoice C early (10-04), and a new 2,500 invoice for Fresh Co is posted, due 10-25.
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: seed.acme,
      paymentDate: D("2026-10-04"),
      amount: "3000.00",
      currency,
      method: "BANK_TRANSFER",
      depositAccountId: seed.bankGlAccountId,
      allocations: [{ invoiceId: seed.invoices.C, amount: "3000.00" }],
    });
    const created = await InvoiceService.create(owner, {
      customerContactId: seed.fresh,
      issueDate: D("2026-10-04"),
      dueDate: D("2026-10-25"),
      currency,
      arAccountId: seed.sales.arAccountId,
      lines: [{ description: "New", quantity: "1", unitPrice: "2500.00", accountId: seed.revenueAccountId }],
    });
    await InvoiceService.approveAndPost(owner, created.id);

    const after = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "30D" });
    expect(after.openingCash.total).toBe("13000.0000");
    // C no longer a future inflow; the new 2,500 appears at its due date 10-25 (Fresh Co has no history, so known only).
    expect(after.lines.some((l) => l.kind === "KNOWN" && l.amount === "3000.0000")).toBe(false);
    const newLine = after.lines.find((l) => l.kind === "KNOWN" && l.amount === "2500.0000") as KnownForecastLine;
    expect(newLine.date).toBe("2026-10-25");
    // 13,000 − 500 − 4,000 − 6,000 + 1,500 + 2,500 − 900 = 5,600.
    expect(after.knownOnly.endBalance).toBe("5600.0000");
  });

  it("every payroll/known/statistical line points at a source document with a link", async () => {
    const f = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "60D" });
    for (const l of f.lines) {
      expect(l.source.id).toBeTruthy();
      expect(l.source.type).toBeTruthy();
      expect(l.source.href).toMatch(/^\//);
    }
  });

  it("PAYROLL OMISSION: a role that can read forecasts but not pay runs gets a complete forecast with payroll lines omitted — no error, no leak", async () => {
    const manager = actorWithRole(owner, "MANAGER");
    const full = await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "60D" });
    const redacted = await CashForecastService.generate(manager, { asOfDate: ASOF, horizon: "60D" });

    expect(full.payrollOmitted).toBe(false);
    expect(full.lines.some((l) => l.category === "PAYROLL_LIABILITY")).toBe(true);
    expect(full.lines.some((l) => l.category === "PAYROLL_PROJECTION")).toBe(true);

    expect(redacted.payrollOmitted).toBe(true);
    expect(redacted.lines.some((l) => l.category === "PAYROLL_LIABILITY" || l.category === "PAYROLL_PROJECTION")).toBe(false);
    expect(redacted.unscheduledKnown.outflows).toBe("0.0000"); // the 4,480 of payroll liabilities isn't even summarised
    expect(redacted.caveats.some((c) => /pay runs/i.test(c))).toBe(true);

    // No payroll-derived figure appears anywhere in the serialized result.
    const serialized = JSON.stringify(redacted);
    for (const secret of ["3084.6154", "915.3846", "480.0000", "Net wages", "PAYG", "Superannuation"]) {
      expect(serialized).not.toContain(secret);
    }

    // Everything non-payroll is identical: the known-only series is unchanged, since payroll liabilities are undated.
    expect(redacted.knownOnly.endBalance).toBe(full.knownOnly.endBalance);
    // The statistical series differs only by the projected payroll.
    expect(redacted.withStatistical.endBalance).not.toBe(full.withStatistical.endBalance);
  });

  it("requires forecast:read — roles without finance visibility are refused", async () => {
    for (const role of ["EMPLOYEE", "PAYROLL_MANAGER", "ACCOUNTS_PAYABLE", "ACCOUNTS_RECEIVABLE"] as const) {
      await expect(CashForecastService.generate(actorWithRole(owner, role), { asOfDate: ASOF })).rejects.toThrow(PermissionDeniedError);
    }
    // And a role that does hold it works.
    await expect(CashForecastService.generate(actorWithRole(owner, "READ_ONLY"), { asOfDate: ASOF })).resolves.toBeDefined();
  });

  it("a forecast never writes to the ledger: the trial balance is identical before and after", async () => {
    const { LedgerService } = await import("@/domain/ledger/ledger-service");
    const before = await LedgerService.getTrialBalance(owner, new Date("2027-12-31"));
    await CashForecastService.generate(owner, { asOfDate: ASOF, horizon: "12M" });
    const after = await LedgerService.getTrialBalance(owner, new Date("2027-12-31"));
    expect(after).toEqual(before);
  });

  it("when the payment run is later cancelled/paid the bill falls back to its own terms (no stale run date)", async () => {
    // Approving pays the bill; the forecast must then no longer contain BILL-3 at all.
    await resetDatabase();
    const org = await createTestOrg("cash-forecast-paid");
    const s = await seedForecastData(org.owner, org.baseCurrency, { paymentRunStatus: "AWAITING_APPROVAL" });
    await PaymentRunService.approve(s.accountant, s.paymentRunId);
    const f = await CashForecastService.generate(org.owner, { asOfDate: D("2026-10-16"), horizon: "30D" });
    expect(f.lines.some((l) => l.amount === "6000.0000")).toBe(false);
  });
});
