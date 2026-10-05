import { Money } from "@/domain/money/money";
import { advanceRecurringDate } from "@/domain/sales/recurring-schedule";
import type { RecurringFrequency } from "@/domain/sales/types";
import type {
  ForecastDirection,
  ForecastLine,
  ForecastSeries,
  ForecastSeriesPoint,
  KnownForecastLine,
  LowCashBreach,
  LowCashWarning,
  StatisticalForecastLine,
} from "./types";

/**
 * Pure, DB-free forecast maths — every function here is exercised directly
 * by `src/tests/unit/forecasting/forecast-calculations.test.ts` against
 * hand-computed inputs. Dates are UTC-midnight throughout (matching how
 * Drizzle round-trips a date-only timestamp), so nothing drifts a day with
 * the server's timezone. Money is `Money`/decimal.js end to end — never a
 * float.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDaysUtc(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

export function dateKey(d: Date): string {
  return startOfUtcDay(d).toISOString().slice(0, 10);
}

export function daysBetweenUtc(later: Date, earlier: Date): number {
  return Math.round((startOfUtcDay(later).getTime() - startOfUtcDay(earlier).getTime()) / DAY_MS);
}

/** `date` moved to `asOf` if it has already passed — the one place "already due" is clamped, so a projection never lands in the past. */
export function clampToAsOf(date: Date, asOf: Date): Date {
  const d = startOfUtcDay(date);
  const a = startOfUtcDay(asOf);
  return d.getTime() < a.getTime() ? a : d;
}

/**
 * The statistical timing shift: a stated due date moved by this customer's
 * historical average lateness (rounded to whole days — the history itself
 * is whole-day settlement-minus-due arithmetic), never earlier than today.
 * An early-paying customer (negative average) shifts EARLIER than the due
 * date; a chronic late payer shifts later. For an invoice already past due
 * whose average-lateness date has also passed, the answer is "today": the
 * history says it is due any day now but says nothing about when.
 */
export function shiftByAverageLateness(statedDate: Date, avgDaysLate: number, asOf: Date): Date {
  return clampToAsOf(addDaysUtc(statedDate, Math.round(avgDaysLate)), asOf);
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

export interface OpenInvoiceInput {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  dueDate: Date;
  outstanding: string;
  customerAvgDaysLate: number | null;
  customerSettledInvoiceCount: number | null;
}

/**
 * One open (approved/sent, unpaid) customer invoice → its KNOWN line plus,
 * when this customer has settled-invoice history that moves the date, a
 * separate STATISTICAL line superseding it in the including-statistical
 * series. An overdue invoice's known line is undated (`date: null`) — see
 * `KnownTiming.OVERDUE_RECEIPT_UNDATED`.
 */
export function classifyOpenInvoice(
  input: OpenInvoiceInput,
  asOf: Date,
): { known: KnownForecastLine; statistical?: StatisticalForecastLine } {
  const overdue = daysBetweenUtc(asOf, input.dueDate) > 0;
  const knownId = `invoice:${input.invoiceId}:known`;
  const source = {
    type: "INVOICE" as const,
    id: input.invoiceId,
    label: `Invoice ${input.invoiceNumber}`,
    href: `/sales/invoices/${input.invoiceId}`,
  };

  const known: KnownForecastLine = {
    kind: "KNOWN",
    id: knownId,
    direction: "IN",
    category: "CUSTOMER_INVOICE",
    label: `Invoice ${input.invoiceNumber}`,
    counterparty: input.customerName,
    amount: input.outstanding,
    date: overdue ? null : dateKey(input.dueDate),
    statedDate: dateKey(input.dueDate),
    timing: overdue ? "OVERDUE_RECEIPT_UNDATED" : "STATED_DUE_DATE",
    source,
    note: overdue
      ? "Overdue: the amount is owed, but no document states when it will be paid, so it is not placed on the known-commitments timeline."
      : undefined,
  };

  if (input.customerAvgDaysLate === null) return { known };

  const expected = shiftByAverageLateness(input.dueDate, input.customerAvgDaysLate, asOf);
  if (known.date !== null && dateKey(expected) === known.date) return { known };

  const statistical: StatisticalForecastLine = {
    kind: "STATISTICAL",
    id: `invoice:${input.invoiceId}:statistical`,
    direction: "IN",
    category: "CUSTOMER_INVOICE",
    label: `Invoice ${input.invoiceNumber} (expected receipt)`,
    counterparty: input.customerName,
    amount: input.outstanding,
    date: dateKey(expected),
    source,
    replacesLineId: knownId,
    basis: {
      type: "CUSTOMER_AVG_DAYS_LATE",
      avgDaysLate: input.customerAvgDaysLate,
      settledInvoiceCount: input.customerSettledInvoiceCount,
    },
    note: `Due ${dateKey(input.dueDate)}; ${input.customerName} has historically paid ${describeLateness(input.customerAvgDaysLate)}.`,
  };
  return { known, statistical };
}

function describeLateness(avg: number): string {
  const rounded = Math.round(avg);
  if (rounded === 0) return "on the due date on average";
  return rounded > 0 ? `${rounded} day(s) after the due date on average` : `${Math.abs(rounded)} day(s) before the due date on average`;
}

export interface OpenBillInput {
  billId: string;
  billNumber: string;
  supplierName: string;
  dueDate: Date;
  outstanding: string;
  /** Set when the bill is inside an APPROVED payment run — that run's own payment date replaces the due date. */
  paymentRun?: { id: string; runNumber: string; paymentDate: Date };
  /**
   * The bill is also in a payment run still AWAITING approval. That is a
   * PROPOSAL, not a commitment (a human may reject or reschedule it), so it
   * does not move the date — it only annotates the line.
   */
  awaitingApprovalRun?: { runNumber: string; paymentDate: Date };
}

/**
 * One open (approved, unpaid) supplier bill → one KNOWN outflow. Bills have
 * no statistical twin: this codebase has no supplier-payment-lateness
 * history comparable to the customer one, and inventing one would be a
 * fabricated pattern. A bill inside an APPROVED payment run is dated at the
 * run's payment date (category `PAYMENT_RUN`) — and, crucially, is emitted
 * ONCE, not once as a bill and again as a run, so approved runs never
 * double-count.
 */
export function classifyOpenBill(input: OpenBillInput, asOf: Date): KnownForecastLine {
  if (input.paymentRun) {
    return {
      kind: "KNOWN",
      id: `bill:${input.billId}:payment_run`,
      direction: "OUT",
      category: "PAYMENT_RUN",
      label: `Bill ${input.billNumber} in payment run ${input.paymentRun.runNumber}`,
      counterparty: input.supplierName,
      amount: input.outstanding,
      date: dateKey(clampToAsOf(input.paymentRun.paymentDate, asOf)),
      statedDate: dateKey(input.paymentRun.paymentDate),
      timing: "SCHEDULED_PAYMENT_RUN",
      source: {
        type: "PAYMENT_RUN",
        id: input.paymentRun.id,
        label: `Payment run ${input.paymentRun.runNumber}`,
        href: `/purchases/payment-runs/${input.paymentRun.id}`,
      },
      note: `Approved payment run, payment date ${dateKey(input.paymentRun.paymentDate)} (bill due ${dateKey(input.dueDate)}).`,
    };
  }

  const overdue = daysBetweenUtc(asOf, input.dueDate) > 0;
  return {
    kind: "KNOWN",
    id: `bill:${input.billId}:known`,
    direction: "OUT",
    category: "SUPPLIER_BILL",
    label: `Bill ${input.billNumber}`,
    counterparty: input.supplierName,
    amount: input.outstanding,
    date: dateKey(clampToAsOf(input.dueDate, asOf)),
    statedDate: dateKey(input.dueDate),
    timing: overdue ? "OVERDUE_ASSUMED_DUE_NOW" : "STATED_DUE_DATE",
    source: { type: "BILL", id: input.billId, label: `Bill ${input.billNumber}`, href: `/purchases/bills/${input.billId}` },
    note:
      [
        overdue ? "Overdue: assumed payable immediately (the prudent direction for money we owe)." : undefined,
        input.awaitingApprovalRun
          ? `Also in payment run ${input.awaitingApprovalRun.runNumber} (payment date ${dateKey(input.awaitingApprovalRun.paymentDate)}), which is still awaiting approval — a proposal, not a commitment, so the date above is unchanged.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

// ---------------------------------------------------------------------------
// Recurring templates
// ---------------------------------------------------------------------------

export interface RecurringTemplateSchedule {
  nextRunDate: Date;
  frequency: RecurringFrequency;
  endDate: Date | null;
  maxOccurrences: number | null;
  occurrencesGenerated: number;
}

/** Same hard ceiling `generateDue` uses so a badly configured template can't run away. */
const MAX_TEMPLATE_OCCURRENCES = 400;

/**
 * Every issue date a template's own explicit schedule will produce whose
 * CASH date (issue date + payment terms) lands on or before `cashHorizonEnd`.
 * Honours `endDate` and `maxOccurrences` exactly as `RecurringInvoiceService.
 * generateDue` does, and walks forward with the same `advanceRecurringDate`
 * the generator uses — so the forecast can never disagree with what the
 * generator will actually do. An overdue `nextRunDate` (backlog) is included:
 * those occurrences WILL generate when the next run happens.
 */
export function upcomingTemplateIssueDates(
  schedule: RecurringTemplateSchedule,
  paymentTermsDays: number,
  cashHorizonEnd: Date,
): Date[] {
  const out: Date[] = [];
  let issue = startOfUtcDay(schedule.nextRunDate);
  let generated = schedule.occurrencesGenerated;
  for (let i = 0; i < MAX_TEMPLATE_OCCURRENCES; i += 1) {
    if (schedule.endDate !== null && issue.getTime() > startOfUtcDay(schedule.endDate).getTime()) break;
    if (schedule.maxOccurrences !== null && generated >= schedule.maxOccurrences) break;
    if (addDaysUtc(issue, paymentTermsDays).getTime() > cashHorizonEnd.getTime()) break;
    out.push(issue);
    generated += 1;
    issue = advanceRecurringDate(issue, schedule.frequency);
  }
  return out;
}

export interface RecurringOccurrenceInput {
  templateId: string;
  templateName: string;
  counterpartyName: string;
  issueDate: Date;
  paymentTermsDays: number;
  /** Template total, tax included, as a positive decimal string. */
  amount: string;
  customerAvgDaysLate?: number | null;
  customerSettledInvoiceCount?: number | null;
}

/** A recurring invoice occurrence → KNOWN inflow (+ a STATISTICAL timing shift for a customer with history). */
export function classifyRecurringInvoiceOccurrence(
  input: RecurringOccurrenceInput,
  asOf: Date,
): { known: KnownForecastLine; statistical?: StatisticalForecastLine } {
  const stated = addDaysUtc(input.issueDate, input.paymentTermsDays);
  const issueKey = dateKey(input.issueDate);
  const knownId = `recurring_invoice:${input.templateId}:${issueKey}:known`;
  const source = {
    type: "RECURRING_INVOICE_TEMPLATE" as const,
    id: input.templateId,
    label: `Recurring invoice "${input.templateName}"`,
    href: `/sales/recurring-invoices/${input.templateId}`,
  };
  const known: KnownForecastLine = {
    kind: "KNOWN",
    id: knownId,
    direction: "IN",
    category: "RECURRING_INVOICE",
    label: `${input.templateName} (issues ${issueKey})`,
    counterparty: input.counterpartyName,
    amount: input.amount,
    date: dateKey(clampToAsOf(stated, asOf)),
    statedDate: dateKey(stated),
    timing: "TEMPLATE_SCHEDULE",
    source,
    note: `Active template, explicit schedule: invoice issues ${issueKey} as a draft for review, due ${input.paymentTermsDays} days later under the platform's default terms. Amount recomputed from current tax rates.`,
  };

  if (input.customerAvgDaysLate === null || input.customerAvgDaysLate === undefined) return { known };
  const expected = shiftByAverageLateness(stated, input.customerAvgDaysLate, asOf);
  if (dateKey(expected) === known.date) return { known };
  return {
    known,
    statistical: {
      kind: "STATISTICAL",
      id: `recurring_invoice:${input.templateId}:${issueKey}:statistical`,
      direction: "IN",
      category: "RECURRING_INVOICE",
      label: `${input.templateName} (issues ${issueKey}, expected receipt)`,
      counterparty: input.counterpartyName,
      amount: input.amount,
      date: dateKey(expected),
      source,
      replacesLineId: knownId,
      basis: {
        type: "CUSTOMER_AVG_DAYS_LATE",
        avgDaysLate: input.customerAvgDaysLate,
        settledInvoiceCount: input.customerSettledInvoiceCount ?? null,
      },
      note: `Due ${dateKey(stated)}; ${input.counterpartyName} has historically paid ${describeLateness(input.customerAvgDaysLate)}.`,
    },
  };
}

/** A recurring bill occurrence → KNOWN outflow. */
export function classifyRecurringBillOccurrence(input: RecurringOccurrenceInput, asOf: Date): KnownForecastLine {
  const stated = addDaysUtc(input.issueDate, input.paymentTermsDays);
  const issueKey = dateKey(input.issueDate);
  return {
    kind: "KNOWN",
    id: `recurring_bill:${input.templateId}:${issueKey}:known`,
    direction: "OUT",
    category: "RECURRING_BILL",
    label: `${input.templateName} (bill ${issueKey})`,
    counterparty: input.counterpartyName,
    amount: input.amount,
    date: dateKey(clampToAsOf(stated, asOf)),
    statedDate: dateKey(stated),
    timing: "TEMPLATE_SCHEDULE",
    source: {
      type: "RECURRING_BILL_TEMPLATE",
      id: input.templateId,
      label: `Recurring bill "${input.templateName}"`,
      href: `/purchases/recurring-bills/${input.templateId}`,
    },
    note: `Active template, explicit schedule: bill generated ${issueKey} as a draft for review, due ${input.paymentTermsDays} days later under the platform's default terms. Amount recomputed from current tax rates.`,
  };
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export type PayrollLiabilityKind = "NET_WAGES" | "PAYG_WITHHOLDING" | "SUPERANNUATION";

export interface PayrollLiabilityInput {
  kind: PayrollLiabilityKind;
  accountId: string;
  accountName: string;
  /** Current credit-normal ledger balance of the payable account, base currency decimal string. */
  balance: string;
  postedRunCount: number;
}

const PAYROLL_LIABILITY_LABEL: Record<PayrollLiabilityKind, string> = {
  NET_WAGES: "Net wages payable",
  PAYG_WITHHOLDING: "PAYG withholding payable",
  SUPERANNUATION: "Superannuation payable",
};

/**
 * Posted pay runs credit three payable accounts (net wages, PAYG
 * withholding, superannuation). Whatever those accounts still owe is a KNOWN
 * amount — but WHEN it leaves the bank is not something this codebase has a
 * verified rule for (see docs/roadmap.md's Phase 8 notes: the PAYG remittance
 * schedule is not modelled, FY2026-27 Payday Super mechanics are explicitly
 * unresolved, and a net-wages payment is a separate manual action). So the
 * line is KNOWN-amount with `timing: "UNVERIFIED"` and NO date — it never
 * silently lands on the timeline at an invented due date. Returns null for a
 * zero/negative balance (nothing owed).
 */
export function buildPayrollLiabilityLine(input: PayrollLiabilityInput): KnownForecastLine | null {
  const balance = Money.of(input.balance, "XXX");
  if (!balance.isPositive()) return null;
  return {
    kind: "KNOWN",
    id: `payroll_liability:${input.kind}:${input.accountId}`,
    direction: "OUT",
    category: "PAYROLL_LIABILITY",
    label: `${PAYROLL_LIABILITY_LABEL[input.kind]} (${input.accountName})`,
    amount: balance.toString(),
    date: null,
    statedDate: null,
    timing: "UNVERIFIED",
    source: { type: "GL_ACCOUNT", id: input.accountId, label: `${input.accountName} (ledger balance)`, href: `/accounting/accounts/${input.accountId}/transactions` },
    note: `Current ledger balance of the account ${input.postedRunCount} posted pay run(s) credited. The amount is known; its due date is not verified in this slice, so it is kept off both timelines.`,
  };
}

export type PayrollFrequency = "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";

export function advancePayDate(date: Date, frequency: PayrollFrequency): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDaysUtc(date, 7);
    case "FORTNIGHTLY":
      return addDaysUtc(date, 14);
    case "MONTHLY":
      return advanceRecurringDate(date, "MONTHLY");
  }
}

/**
 * STATISTICAL payroll projection: repeat the most recent POSTED pay run's
 * net-wages total at its pay frequency, for pay dates from today through the
 * horizon. This is deliberately NOT known — hours, headcount and rates all
 * change between runs, and no pay run exists yet for those dates. Only net
 * wages are projected (the payee-facing cash); PAYG/super remittance timing
 * is unverified, so those are never projected forward.
 */
export function projectPayrollNetWages(
  last: { payRunId: string; payDate: Date; payFrequency: PayrollFrequency; netPay: string },
  asOf: Date,
  horizonEnd: Date,
): StatisticalForecastLine[] {
  const out: StatisticalForecastLine[] = [];
  let next = advancePayDate(last.payDate, last.payFrequency);
  for (let i = 0; i < 400 && next.getTime() <= horizonEnd.getTime(); i += 1) {
    if (next.getTime() >= startOfUtcDay(asOf).getTime()) {
      out.push({
        kind: "STATISTICAL",
        id: `payroll_projection:${last.payRunId}:${dateKey(next)}`,
        direction: "OUT",
        category: "PAYROLL_PROJECTION",
        label: `Projected ${last.payFrequency.toLowerCase()} net wages`,
        amount: last.netPay,
        date: dateKey(next),
        source: { type: "PAY_RUN", id: last.payRunId, label: "Last posted pay run", href: `/payroll/pay-runs/${last.payRunId}` },
        basis: { type: "REPEAT_OF_LAST_POSTED_PAY_RUN", payFrequency: last.payFrequency, lastPayDate: dateKey(last.payDate) },
        note: "A repeat of the last posted pay run's net wages — headcount, hours and rates may change. PAYG and super remittances are not projected (timing unverified).",
      });
    }
    next = advancePayDate(next, last.payFrequency);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

export type SeriesMode = "KNOWN_ONLY" | "INCLUDING_STATISTICAL";

/** The lines a given series is built from — the structural separation in one function. */
export function linesForSeries(lines: ForecastLine[], mode: SeriesMode): Array<ForecastLine & { date: string }> {
  const replaced = new Set<string>();
  if (mode === "INCLUDING_STATISTICAL") {
    for (const l of lines) {
      if (l.kind === "STATISTICAL" && l.replacesLineId) replaced.add(l.replacesLineId);
    }
  }
  const out: Array<ForecastLine & { date: string }> = [];
  for (const l of lines) {
    if (l.date === null) continue;
    if (mode === "KNOWN_ONLY" && l.kind !== "KNOWN") continue;
    if (mode === "INCLUDING_STATISTICAL" && l.kind === "KNOWN" && replaced.has(l.id)) continue;
    out.push(l as ForecastLine & { date: string });
  }
  return out;
}

export interface DailyBalance {
  date: string;
  balance: Money;
}

export interface DailySeriesResult {
  daily: DailyBalance[];
  totalIn: Money;
  totalOut: Money;
}

/**
 * Day-by-day end-of-day balances from `asOf` (day 0) through
 * `asOf + horizonDays`. Day 0 includes any flow dated today; a flow dated
 * before today is treated as today (it is still unpaid — that is why it's
 * in the forecast at all); a flow dated after the horizon is ignored.
 * Always computed daily, even for horizons displayed weekly, so the low
 * point and first-breach date are day-exact regardless of display
 * granularity.
 */
export function buildDailySeries(
  openingCash: Money,
  lines: Array<{ direction: ForecastDirection; amount: string; date: string }>,
  asOf: Date,
  horizonDays: number,
): DailySeriesResult {
  const currency = openingCash.currency;
  const netByDay = new Map<string, Money>();
  let totalIn = Money.zero(currency);
  let totalOut = Money.zero(currency);
  const startKey = dateKey(asOf);
  const endKey = dateKey(addDaysUtc(asOf, horizonDays));

  for (const line of lines) {
    const key = line.date < startKey ? startKey : line.date;
    if (key > endKey) continue;
    const amount = Money.of(line.amount, currency);
    const signed = line.direction === "IN" ? amount : amount.negate();
    netByDay.set(key, (netByDay.get(key) ?? Money.zero(currency)).add(signed));
    if (line.direction === "IN") totalIn = totalIn.add(amount);
    else totalOut = totalOut.add(amount);
  }

  const daily: DailyBalance[] = [];
  let balance = openingCash;
  for (let i = 0; i <= horizonDays; i += 1) {
    const key = dateKey(addDaysUtc(asOf, i));
    balance = balance.add(netByDay.get(key) ?? Money.zero(currency));
    daily.push({ date: key, balance });
  }
  return { daily, totalIn, totalOut };
}

/**
 * Display points: every day for horizons up to 90 days; end-of-week (day 7,
 * 14, …) plus the final day for the 12-month horizon — daily resolution a
 * year out would be false precision (the statistical shifts themselves are
 * only accurate to a few days) and 365 points per series is noise on a page.
 */
export function displayPoints(daily: DailyBalance[], granularity: "DAILY" | "WEEKLY"): ForecastSeriesPoint[] {
  const picked =
    granularity === "DAILY"
      ? daily
      : daily.filter((_, i) => i === 0 || i % 7 === 0 || i === daily.length - 1);
  return picked.map((d) => ({ date: d.date, balance: d.balance.toString() }));
}

export function lowestPoint(daily: DailyBalance[]): { date: string; balance: string } {
  let low = daily[0]!;
  for (const d of daily) {
    if (d.balance.compareTo(low.balance) < 0) low = d;
  }
  return { date: low.date, balance: low.balance.toString() };
}

export function buildSeries(
  openingCash: Money,
  lines: ForecastLine[],
  mode: SeriesMode,
  asOf: Date,
  horizonDays: number,
  granularity: "DAILY" | "WEEKLY",
): { series: ForecastSeries; daily: DailyBalance[] } {
  const { daily, totalIn, totalOut } = buildDailySeries(openingCash, linesForSeries(lines, mode), asOf, horizonDays);
  return {
    daily,
    series: {
      points: displayPoints(daily, granularity),
      endBalance: daily[daily.length - 1]!.balance.toString(),
      lowPoint: lowestPoint(daily),
      totalIn: totalIn.toString(),
      totalOut: totalOut.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Low-cash warning
// ---------------------------------------------------------------------------

/** First day whose end-of-day balance is strictly below `threshold`, or null. */
export function firstBreach(daily: DailyBalance[], threshold: Money, asOf: Date): LowCashBreach | null {
  for (const d of daily) {
    if (d.balance.compareTo(threshold) < 0) {
      return { date: d.date, daysFromNow: daysBetweenUtc(new Date(`${d.date}T00:00:00Z`), asOf), balance: d.balance.toString() };
    }
  }
  return null;
}

/** Display-only formatting from the exact decimal (never via a float): 2 dp with thousands separators. */
export function formatMoneyForMessage(amount: string, currency: string): string {
  const fixed = Money.of(amount, currency).toDecimal().toFixed(2);
  const [whole, frac] = fixed.split(".");
  const negative = whole!.startsWith("-");
  const digits = negative ? whole!.slice(1) : whole!;
  return `${negative ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac} ${currency}`;
}

const money = formatMoneyForMessage;

function describeBreach(b: LowCashBreach, threshold: string, currency: string, which: string): string {
  const when = b.daysFromNow <= 0 ? "already" : `on ${b.date} (in ${b.daysFromNow} day${b.daysFromNow === 1 ? "" : "s"})`;
  return `On the ${which} projection, cash ${b.daysFromNow <= 0 ? "is already" : "may fall"} below ${money(threshold, currency)}${b.daysFromNow <= 0 ? "" : ` ${when}`} (projected balance ${money(b.balance, currency)}).`;
}

/**
 * The master spec §6 "Cash Warning" insight ("operating account may fall
 * below $18,000 in approximately 17 days"), computed on BOTH series
 * independently — a breach on the known-only series is a hard signal (it
 * needs no estimate to happen), a breach only on the statistical series is
 * an estimate-driven one, and the message always names which.
 */
export function buildLowCashWarning(
  knownDaily: DailyBalance[],
  statDaily: DailyBalance[],
  thresholdStr: string,
  currency: string,
  asOf: Date,
): LowCashWarning {
  const threshold = Money.of(thresholdStr, currency);
  const knownOnly = firstBreach(knownDaily, threshold, asOf);
  const withStatistical = firstBreach(statDaily, threshold, asOf);

  let first: LowCashWarning["firstBreach"] = null;
  if (knownOnly && (!withStatistical || knownOnly.date <= withStatistical.date)) first = { ...knownOnly, series: "KNOWN_ONLY" };
  else if (withStatistical) first = { ...withStatistical, series: "INCLUDING_STATISTICAL" };

  const parts: string[] = [];
  if (knownOnly) parts.push(describeBreach(knownOnly, thresholdStr, currency, "known-commitments-only"));
  if (withStatistical) parts.push(describeBreach(withStatistical, thresholdStr, currency, "including-statistical"));

  return {
    threshold: threshold.toString(),
    knownOnly,
    withStatistical,
    firstBreach: first,
    message: parts.length > 0 ? parts.join(" ") : null,
  };
}

/** Lowest known-only balance if every undated OUTFLOW were paid on day zero — see `UnscheduledKnownSummary`. */
export function lowPointIfUnscheduledOutflowsPaidNow(knownDaily: DailyBalance[], unscheduledOutflows: Money): string {
  const low = lowestPoint(knownDaily);
  return Money.of(low.balance, unscheduledOutflows.currency).subtract(unscheduledOutflows).toString();
}
