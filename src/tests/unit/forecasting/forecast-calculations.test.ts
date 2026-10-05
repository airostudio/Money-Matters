import { describe, expect, it } from "vitest";
import { Money } from "@/domain/money/money";
import {
  buildDailySeries,
  buildLowCashWarning,
  buildPayrollLiabilityLine,
  buildSeries,
  classifyOpenBill,
  classifyOpenInvoice,
  classifyRecurringBillOccurrence,
  classifyRecurringInvoiceOccurrence,
  displayPoints,
  firstBreach,
  formatMoneyForMessage,
  linesForSeries,
  lowPointIfUnscheduledOutflowsPaidNow,
  projectPayrollNetWages,
  shiftByAverageLateness,
  upcomingTemplateIssueDates,
} from "@/domain/forecasting/forecast-calculations";
import type { ForecastLine, KnownForecastLine, StatisticalForecastLine } from "@/domain/forecasting/types";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ASOF = D("2026-10-05"); // a Monday

describe("shiftByAverageLateness", () => {
  it("moves a Friday due date by a 12-day average lateness to the following Wednesday", () => {
    // 2026-10-09 is a Friday; +12 days is Wednesday 2026-10-21.
    const shifted = shiftByAverageLateness(D("2026-10-09"), 12, ASOF);
    expect(shifted.toISOString().slice(0, 10)).toBe("2026-10-21");
    expect(shifted.getUTCDay()).toBe(3);
  });

  it("rounds a fractional average to whole days", () => {
    expect(shiftByAverageLateness(D("2026-10-09"), 12.4, ASOF).toISOString().slice(0, 10)).toBe("2026-10-21");
    expect(shiftByAverageLateness(D("2026-10-09"), 12.6, ASOF).toISOString().slice(0, 10)).toBe("2026-10-22");
  });

  it("shifts an early-paying customer earlier, but never before today", () => {
    expect(shiftByAverageLateness(D("2026-10-20"), -5, ASOF).toISOString().slice(0, 10)).toBe("2026-10-15");
    expect(shiftByAverageLateness(D("2026-10-07"), -10, ASOF).toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  it("an overdue invoice whose average-lateness date has also passed is expected today", () => {
    expect(shiftByAverageLateness(D("2026-09-01"), 12, ASOF).toISOString().slice(0, 10)).toBe("2026-10-05");
  });
});

describe("classifyOpenInvoice — KNOWN vs STATISTICAL", () => {
  const base = {
    invoiceId: "inv-1",
    invoiceNumber: "INV-0001",
    customerName: "Slow Payer Pty Ltd",
    outstanding: "1000.0000",
    customerSettledInvoiceCount: 3,
  };

  it("a not-yet-due invoice is a KNOWN line at its due date, plus a SEPARATE statistical line that supersedes it", () => {
    const { known, statistical } = classifyOpenInvoice({ ...base, dueDate: D("2026-10-09"), customerAvgDaysLate: 12 }, ASOF);

    expect(known.kind).toBe("KNOWN");
    expect(known.direction).toBe("IN");
    expect(known.date).toBe("2026-10-09");
    expect(known.timing).toBe("STATED_DUE_DATE");

    expect(statistical).toBeDefined();
    expect(statistical!.kind).toBe("STATISTICAL");
    expect(statistical!.date).toBe("2026-10-21");
    expect(statistical!.replacesLineId).toBe(known.id);
    expect(statistical!.basis).toEqual({ type: "CUSTOMER_AVG_DAYS_LATE", avgDaysLate: 12, settledInvoiceCount: 3 });
    // The two lines carry the SAME cash, just different dates — never two separate receipts.
    expect(statistical!.amount).toBe(known.amount);
  });

  it("a customer with no settled-invoice history gets NO statistical line (nothing invented)", () => {
    const { known, statistical } = classifyOpenInvoice({ ...base, dueDate: D("2026-10-09"), customerAvgDaysLate: null, customerSettledInvoiceCount: 0 }, ASOF);
    expect(known.date).toBe("2026-10-09");
    expect(statistical).toBeUndefined();
  });

  it("an on-time payer (0 days late) gets no statistical line — it would not change anything", () => {
    const { statistical } = classifyOpenInvoice({ ...base, dueDate: D("2026-10-09"), customerAvgDaysLate: 0 }, ASOF);
    expect(statistical).toBeUndefined();
  });

  it("an OVERDUE invoice is KNOWN-amount but undated (not on the known timeline); history gives it a statistical date", () => {
    const { known, statistical } = classifyOpenInvoice({ ...base, dueDate: D("2026-09-20"), customerAvgDaysLate: 30 }, ASOF);
    expect(known.date).toBeNull();
    expect(known.timing).toBe("OVERDUE_RECEIPT_UNDATED");
    expect(known.statedDate).toBe("2026-09-20");
    // 2026-09-20 + 30 days = 2026-10-20.
    expect(statistical!.date).toBe("2026-10-20");
    expect(statistical!.replacesLineId).toBe(known.id);
  });

  it("an overdue invoice with no history stays undated in both series", () => {
    const { known, statistical } = classifyOpenInvoice({ ...base, dueDate: D("2026-09-20"), customerAvgDaysLate: null }, ASOF);
    expect(known.date).toBeNull();
    expect(statistical).toBeUndefined();
  });
});

describe("classifyOpenBill", () => {
  const base = { billId: "bill-1", billNumber: "BILL-1", supplierName: "Supplier Co", outstanding: "800.0000" };

  it("an open bill is a KNOWN outflow at its due date", () => {
    const line = classifyOpenBill({ ...base, dueDate: D("2026-10-12") }, ASOF);
    expect(line).toMatchObject({ kind: "KNOWN", direction: "OUT", category: "SUPPLIER_BILL", date: "2026-10-12", timing: "STATED_DUE_DATE" });
  });

  it("an overdue bill is assumed payable today (prudent for an outflow)", () => {
    const line = classifyOpenBill({ ...base, dueDate: D("2026-09-01") }, ASOF);
    expect(line.date).toBe("2026-10-05");
    expect(line.statedDate).toBe("2026-09-01");
    expect(line.timing).toBe("OVERDUE_ASSUMED_DUE_NOW");
  });

  it("a bill in an APPROVED payment run is dated at the run's payment date, as ONE line (no bill + run double count)", () => {
    const line = classifyOpenBill(
      { ...base, dueDate: D("2026-10-30"), paymentRun: { id: "run-1", runNumber: "PR-0001", paymentDate: D("2026-10-10") } },
      ASOF,
    );
    expect(line.category).toBe("PAYMENT_RUN");
    expect(line.date).toBe("2026-10-10");
    expect(line.timing).toBe("SCHEDULED_PAYMENT_RUN");
    expect(line.source.type).toBe("PAYMENT_RUN");
  });
});

describe("recurring templates", () => {
  it("lists a monthly template's occurrences whose cash date lands within the horizon (30-day terms)", () => {
    // Next run 2026-10-10 monthly. Horizon end 2026-12-31: issue 10-10 (cash 11-09), 11-10 (cash 12-10); 12-10 → cash 2027-01-09 is beyond.
    const dates = upcomingTemplateIssueDates(
      { nextRunDate: D("2026-10-10"), frequency: "MONTHLY", endDate: null, maxOccurrences: null, occurrencesGenerated: 0 },
      30,
      D("2026-12-31"),
    );
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-10", "2026-11-10"]);
  });

  it("honours maxOccurrences (counting those already generated) and endDate", () => {
    const capped = upcomingTemplateIssueDates(
      { nextRunDate: D("2026-10-01"), frequency: "WEEKLY", endDate: null, maxOccurrences: 5, occurrencesGenerated: 3 },
      0,
      D("2027-10-01"),
    );
    expect(capped).toHaveLength(2);

    const ended = upcomingTemplateIssueDates(
      { nextRunDate: D("2026-10-01"), frequency: "WEEKLY", endDate: D("2026-10-15"), maxOccurrences: null, occurrencesGenerated: 0 },
      0,
      D("2027-10-01"),
    );
    expect(ended.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-01", "2026-10-08", "2026-10-15"]);
  });

  it("includes backlog occurrences whose run date has already passed", () => {
    const dates = upcomingTemplateIssueDates(
      { nextRunDate: D("2026-09-01"), frequency: "MONTHLY", endDate: null, maxOccurrences: null, occurrencesGenerated: 0 },
      30,
      D("2026-11-30"),
    );
    // 09-01 (cash 10-01), 10-01 (cash 10-31), 11-01 (cash 12-01 — beyond) → two.
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("a recurring invoice occurrence is a KNOWN inflow at issue date + terms, with a statistical shift only when the customer has history that moves it", () => {
    const input = {
      templateId: "t-1",
      templateName: "Retainer",
      counterpartyName: "Acme",
      issueDate: D("2026-10-10"),
      paymentTermsDays: 30,
      amount: "2200.0000",
    };
    const { known, statistical } = classifyRecurringInvoiceOccurrence({ ...input, customerAvgDaysLate: 7, customerSettledInvoiceCount: 4 }, ASOF);
    expect(known).toMatchObject({ kind: "KNOWN", category: "RECURRING_INVOICE", timing: "TEMPLATE_SCHEDULE", date: "2026-11-09" });
    expect(statistical).toMatchObject({ kind: "STATISTICAL", date: "2026-11-16", replacesLineId: known.id });

    expect(classifyRecurringInvoiceOccurrence({ ...input, customerAvgDaysLate: null }, ASOF).statistical).toBeUndefined();
  });

  it("a recurring bill occurrence is a KNOWN outflow", () => {
    const line = classifyRecurringBillOccurrence(
      { templateId: "t-2", templateName: "Rent", counterpartyName: "Landlord", issueDate: D("2026-10-01"), paymentTermsDays: 30, amount: "3000.0000" },
      ASOF,
    );
    expect(line).toMatchObject({ kind: "KNOWN", direction: "OUT", category: "RECURRING_BILL", date: "2026-10-31" });
  });
});

describe("payroll lines", () => {
  it("a payroll liability is a KNOWN amount with UNVERIFIED timing and NO date — never an invented due date", () => {
    const line = buildPayrollLiabilityLine({
      kind: "PAYG_WITHHOLDING",
      accountId: "acc-1",
      accountName: "PAYG Withholding Payable",
      balance: "4200.0000",
      postedRunCount: 2,
    })!;
    expect(line.kind).toBe("KNOWN");
    expect(line.timing).toBe("UNVERIFIED");
    expect(line.date).toBeNull();
    expect(line.statedDate).toBeNull();
    expect(line.amount).toBe("4200.0000");
  });

  it("a settled (zero or negative) payable produces no line", () => {
    const input = { kind: "NET_WAGES" as const, accountId: "a", accountName: "n", postedRunCount: 1 };
    expect(buildPayrollLiabilityLine({ ...input, balance: "0.0000" })).toBeNull();
    expect(buildPayrollLiabilityLine({ ...input, balance: "-10.0000" })).toBeNull();
  });

  it("projects the last pay run's net wages forward at its frequency as STATISTICAL lines", () => {
    // Fortnightly, last pay date 2026-10-02; next 10-16, 10-30, 11-13 (horizon end 11-15).
    const lines = projectPayrollNetWages({ payRunId: "pr-1", payDate: D("2026-10-02"), payFrequency: "FORTNIGHTLY", netPay: "5000.0000" }, ASOF, D("2026-11-15"));
    expect(lines.map((l) => l.date)).toEqual(["2026-10-16", "2026-10-30", "2026-11-13"]);
    expect(lines.every((l) => l.kind === "STATISTICAL" && l.direction === "OUT" && l.amount === "5000.0000")).toBe(true);
    expect(lines[0]!.replacesLineId).toBeUndefined();
  });

  it("skips projected pay dates that fall before today", () => {
    const lines = projectPayrollNetWages({ payRunId: "pr-1", payDate: D("2026-09-01"), payFrequency: "WEEKLY", netPay: "100.0000" }, ASOF, D("2026-10-12"));
    // 09-08, 09-15, 09-22, 09-29 are before 10-05; 10-06 and nothing else before 10-12 → 10-06 only (10-13 > horizon).
    expect(lines.map((l) => l.date)).toEqual(["2026-10-06"]);
  });
});

function known(id: string, direction: "IN" | "OUT", amount: string, date: string | null): KnownForecastLine {
  return {
    kind: "KNOWN",
    id,
    direction,
    category: direction === "IN" ? "CUSTOMER_INVOICE" : "SUPPLIER_BILL",
    label: id,
    amount,
    date,
    statedDate: date,
    timing: "STATED_DUE_DATE",
    source: { type: "INVOICE", id, label: id, href: null },
  };
}

function statistical(id: string, direction: "IN" | "OUT", amount: string, date: string, replacesLineId?: string): StatisticalForecastLine {
  return {
    kind: "STATISTICAL",
    id,
    direction,
    category: "CUSTOMER_INVOICE",
    label: id,
    amount,
    date,
    replacesLineId,
    basis: { type: "CUSTOMER_AVG_DAYS_LATE", avgDaysLate: 5, settledInvoiceCount: 2 },
    source: { type: "INVOICE", id, label: id, href: null },
  };
}

describe("series: known-only vs including-statistical are separate", () => {
  const lines: ForecastLine[] = [
    known("A", "IN", "500.0000", "2026-10-07"),
    known("B", "OUT", "800.0000", "2026-10-08"),
    statistical("A-stat", "IN", "500.0000", "2026-10-12", "A"), // A is expected 5 days later than known
    statistical("trend", "OUT", "50.0000", "2026-10-06"), // purely additive projection
  ];

  it("linesForSeries: the known-only series contains no statistical line; the statistical series swaps the superseded known line for its twin", () => {
    expect(linesForSeries(lines, "KNOWN_ONLY").map((l) => l.id)).toEqual(["A", "B"]);
    expect(linesForSeries(lines, "INCLUDING_STATISTICAL").map((l) => l.id).sort()).toEqual(["A-stat", "B", "trend"]);
  });

  it("builds the two series with hand-computed balances", () => {
    const opening = Money.of("1000.00", "AUD");
    const horizon = 10;
    const k = buildSeries(opening, lines, "KNOWN_ONLY", ASOF, horizon, "DAILY");
    const s = buildSeries(opening, lines, "INCLUDING_STATISTICAL", ASOF, horizon, "DAILY");

    // Known-only: 1000; +500 on day 2 (10-07) → 1500; −800 on day 3 (10-08) → 700; flat after.
    expect(k.series.points).toHaveLength(11);
    expect(k.series.points[0]).toEqual({ date: "2026-10-05", balance: "1000.0000" });
    expect(k.series.points[2]!.balance).toBe("1500.0000");
    expect(k.series.points[3]!.balance).toBe("700.0000");
    expect(k.series.endBalance).toBe("700.0000");
    expect(k.series.lowPoint).toEqual({ date: "2026-10-08", balance: "700.0000" });
    expect(k.series.totalIn).toBe("500.0000");
    expect(k.series.totalOut).toBe("800.0000");

    // Including statistical: −50 on day 1 (10-06) → 950; −800 on day 3 → 150; +500 on day 7 (10-12) → 650.
    expect(s.series.points[1]!.balance).toBe("950.0000");
    expect(s.series.points[3]!.balance).toBe("150.0000");
    expect(s.series.points[7]!.balance).toBe("650.0000");
    expect(s.series.endBalance).toBe("650.0000");
    expect(s.series.lowPoint).toEqual({ date: "2026-10-08", balance: "150.0000" });

    // The two series genuinely differ — they are not one blended number.
    expect(k.series.endBalance).not.toBe(s.series.endBalance);
  });

  it("a flow dated before today lands on day 0; a flow beyond the horizon is ignored", () => {
    const { daily, totalIn, totalOut } = buildDailySeries(
      Money.of("1000", "AUD"),
      [
        { direction: "OUT", amount: "300", date: "2026-10-04" },
        { direction: "IN", amount: "100", date: "2026-10-20" },
        { direction: "IN", amount: "500", date: "2026-10-07" },
        { direction: "OUT", amount: "800", date: "2026-10-08" },
      ],
      ASOF,
      7,
    );
    expect(daily.map((d) => d.balance.toString())).toEqual([
      "700.0000", // day 0: 1000 − 300 (overdue outflow clamped to today)
      "700.0000",
      "1200.0000",
      "400.0000",
      "400.0000",
      "400.0000",
      "400.0000",
      "400.0000",
    ]);
    expect(totalIn.toString()).toBe("500.0000");
    expect(totalOut.toString()).toBe("1100.0000");
  });

  it("undated known lines are in neither series", () => {
    const withUndated: ForecastLine[] = [...lines, known("overdue", "IN", "9999.0000", null)];
    expect(linesForSeries(withUndated, "KNOWN_ONLY").map((l) => l.id)).not.toContain("overdue");
    expect(linesForSeries(withUndated, "INCLUDING_STATISTICAL").map((l) => l.id)).not.toContain("overdue");
  });

  it("an undated known line WITH a statistical twin enters only the statistical series", () => {
    const l: ForecastLine[] = [known("late", "IN", "700.0000", null), statistical("late-stat", "IN", "700.0000", "2026-10-09", "late")];
    expect(linesForSeries(l, "KNOWN_ONLY")).toHaveLength(0);
    expect(linesForSeries(l, "INCLUDING_STATISTICAL").map((x) => x.id)).toEqual(["late-stat"]);
  });

  it("weekly display for 12 months: day 0, every 7th day and the final day — while the low point still comes from the DAILY series", () => {
    const opening = Money.of("100", "AUD");
    // A one-day dip on day 10 (not a week boundary) that a weekly sample would miss.
    const { series } = buildSeries(
      opening,
      [known("dip-out", "OUT", "150", "2026-10-15"), known("dip-in", "IN", "150", "2026-10-16")],
      "KNOWN_ONLY",
      ASOF,
      365,
      "WEEKLY",
    );
    expect(series.points[0]!.date).toBe("2026-10-05");
    expect(series.points[1]!.date).toBe("2026-10-12");
    expect(series.points.at(-1)!.date).toBe("2027-10-05");
    expect(series.points.length).toBe(1 + 52 + 1); // day 0, weeks 1..52 (day 364), day 365
    expect(series.points.some((p) => p.balance === "-50.0000")).toBe(false);
    expect(series.lowPoint).toEqual({ date: "2026-10-15", balance: "-50.0000" });
  });

  it("displayPoints in DAILY mode returns every day", () => {
    const { daily } = buildDailySeries(Money.of("1", "AUD"), [], ASOF, 7);
    expect(displayPoints(daily, "DAILY")).toHaveLength(8);
  });
});

describe("low-cash warning", () => {
  const opening = Money.of("1000", "AUD");
  const mk = (flows: Array<{ direction: "IN" | "OUT"; amount: string; date: string }>, days = 30) =>
    buildDailySeries(opening, flows, ASOF, days).daily;

  it("firstBreach finds the first day strictly below the threshold, with days-from-now", () => {
    const daily = mk([
      { direction: "OUT", amount: "600", date: "2026-10-10" },
      { direction: "OUT", amount: "500", date: "2026-10-22" },
    ]);
    // Balance: 1000 until 10-10 → 400 → 10-22 → −100. Threshold 500: first below on 10-10 (day 5).
    expect(firstBreach(daily, Money.of("500", "AUD"), ASOF)).toEqual({ date: "2026-10-10", daysFromNow: 5, balance: "400.0000" });
    // Threshold 0: first below on 10-22 (day 17).
    expect(firstBreach(daily, Money.of("0", "AUD"), ASOF)).toEqual({ date: "2026-10-22", daysFromNow: 17, balance: "-100.0000" });
    // Exactly at the threshold is NOT a breach.
    expect(firstBreach(mk([{ direction: "OUT", amount: "500", date: "2026-10-10" }]), Money.of("500", "AUD"), ASOF)).toBeNull();
  });

  it("evaluates both series independently and names which one breached first", () => {
    const knownDaily = mk([{ direction: "OUT", amount: "1200", date: "2026-10-25" }]); // known-only breaches 10-25
    const statDaily = mk([{ direction: "OUT", amount: "1200", date: "2026-10-18" }]); // statistical breaches earlier
    const w = buildLowCashWarning(knownDaily, statDaily, "0", "AUD", ASOF);

    expect(w.knownOnly?.date).toBe("2026-10-25");
    expect(w.withStatistical?.date).toBe("2026-10-18");
    expect(w.firstBreach).toMatchObject({ series: "INCLUDING_STATISTICAL", date: "2026-10-18", daysFromNow: 13 });
    expect(w.message).toContain("known-commitments-only");
    expect(w.message).toContain("including-statistical");
    expect(w.message).toContain("2026-10-25");
  });

  it("a breach only on the statistical series leaves knownOnly null — an estimate-driven warning, labelled as such", () => {
    const knownDaily = mk([]);
    const statDaily = mk([{ direction: "OUT", amount: "1500", date: "2026-10-12" }]);
    const w = buildLowCashWarning(knownDaily, statDaily, "0", "AUD", ASOF);
    expect(w.knownOnly).toBeNull();
    expect(w.withStatistical).not.toBeNull();
    expect(w.message).toContain("including-statistical");
    expect(w.message).not.toContain("known-commitments-only");
  });

  it("no breach → no message", () => {
    const w = buildLowCashWarning(mk([]), mk([]), "0", "AUD", ASOF);
    expect(w.firstBreach).toBeNull();
    expect(w.message).toBeNull();
  });

  it("already below the threshold today reads 'already', not '0 days'", () => {
    const daily = buildDailySeries(Money.of("100", "AUD"), [], ASOF, 7).daily;
    const w = buildLowCashWarning(daily, daily, "500", "AUD", ASOF);
    expect(w.knownOnly?.daysFromNow).toBe(0);
    expect(w.message).toContain("already");
  });

  it("the 'unscheduled outflows paid now' prudence floor is the known low point minus the undated outflows", () => {
    const daily = mk([{ direction: "OUT", amount: "600", date: "2026-10-10" }]); // low 400
    expect(lowPointIfUnscheduledOutflowsPaidNow(daily, Money.of("1000", "AUD"))).toBe("-600.0000");
  });

  it("formats money for messages exactly, with thousands separators", () => {
    expect(formatMoneyForMessage("18000", "AUD")).toBe("18,000.00 AUD");
    expect(formatMoneyForMessage("-1234567.8", "AUD")).toBe("-1,234,567.80 AUD");
  });
});
