import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  contacts,
  paymentRunItems,
  paymentRuns,
  recurringBillTemplateLines,
  recurringBillTemplates,
  recurringInvoiceTemplateLines,
  recurringInvoiceTemplates,
  taxCodes,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Money } from "@/domain/money/money";
import { loadCashPosition, type CashPosition } from "@/domain/reporting/cash-position";
import {
  AgedReceivablesService,
  loadCustomerPaymentHistory,
  type PrioritizedInvoiceRow,
} from "@/domain/sales/aged-receivables-service";
import { AgedPayablesService, type AgedSupplierRow } from "@/domain/purchases/aged-payables-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { calculateInvoiceTotals } from "@/domain/sales/invoice-calculations";
import { calculateBillTotals } from "@/domain/purchases/bill-calculations";
import { DEFAULT_DUE_DAYS as INVOICE_DEFAULT_DUE_DAYS } from "@/domain/sales/recurring-invoice-service";
import { DEFAULT_DUE_DAYS as BILL_DEFAULT_DUE_DAYS } from "@/domain/purchases/recurring-bill-service";
import { loadLowCashThreshold } from "./forecast-settings-service";
import {
  addDaysUtc,
  buildLowCashWarning,
  buildPayrollLiabilityLine,
  buildSeries,
  classifyOpenBill,
  classifyOpenInvoice,
  classifyRecurringBillOccurrence,
  classifyRecurringInvoiceOccurrence,
  dateKey,
  lowPointIfUnscheduledOutflowsPaidNow,
  projectPayrollNetWages,
  startOfUtcDay,
  upcomingTemplateIssueDates,
  type PayrollLiabilityKind,
} from "./forecast-calculations";
import {
  HORIZON_DAYS,
  type CashForecast,
  type ForecastHorizon,
  type ForecastLine,
  type KnownForecastLine,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GenerateForecastOptions {
  /** The "today" the forecast starts from. Defaults to now. Tests pin it. */
  asOfDate?: Date;
  /** Default 90D. */
  horizon?: ForecastHorizon;
  /**
   * Inputs the caller has already loaded (the Daily Finance Brief has the
   * cash position, aged receivables and aged payables in hand) — reused as-is
   * instead of re-querying, which keeps the brief's database round-trips down.
   */
  preloaded?: {
    cashPosition?: CashPosition;
    receivables?: PrioritizedInvoiceRow[];
    payables?: AgedSupplierRow[];
  };
}

interface PaymentRunItemInfo {
  runId: string;
  runNumber: string;
  paymentDate: Date;
  amount: string;
}

interface TemplateData {
  recurringInvoices: Array<{
    template: typeof recurringInvoiceTemplates.$inferSelect;
    customerName: string;
    total: string | null;
    error?: string;
  }>;
  recurringBills: Array<{
    template: typeof recurringBillTemplates.$inferSelect;
    supplierName: string;
    total: string | null;
    error?: string;
  }>;
  /** Payment history for every customer behind an active recurring invoice template. */
  customerHistory: Map<string, { averageDaysLate: number | null; settledInvoiceCount: number }>;
  approvedRunItemsByBill: Map<string, PaymentRunItemInfo>;
  /** Bills sitting in a run that is still AWAITING approval — annotated, never re-dated (see `OpenBillInput.awaitingApprovalRun`). */
  awaitingRunItemsByBill: Map<string, PaymentRunItemInfo>;
  lowCashThreshold: string;
}

/**
 * Everything the forecast needs that no existing read service already
 * returns, fetched in ONE tenant transaction (a handful of sequential
 * queries, no fan-out): the low-cash threshold, APPROVED payment runs' items,
 * and active recurring invoice/bill templates with their lines and tax
 * rates. Permission is the caller's `forecast:read` check — see
 * `CashForecastService.generate`.
 */
async function loadTemplateData(
  tx: TenantDb,
  organizationId: string,
  currency: string,
  knownHistory: Map<string, { averageDaysLate: number | null; settledInvoiceCount: number }>,
): Promise<TemplateData> {
  const lowCashThreshold = await loadLowCashThreshold(tx, organizationId);

  const runRows = await tx
    .select({
      runId: paymentRuns.id,
      runNumber: paymentRuns.runNumber,
      paymentDate: paymentRuns.paymentDate,
      billId: paymentRunItems.billId,
      amount: paymentRunItems.amount,
      status: paymentRuns.status,
    })
    .from(paymentRunItems)
    .innerJoin(paymentRuns, eq(paymentRuns.id, paymentRunItems.paymentRunId))
    .where(
      and(
        eq(paymentRuns.organizationId, organizationId),
        inArray(paymentRuns.status, ["APPROVED", "AWAITING_APPROVAL"]),
      ),
    )
    .orderBy(asc(paymentRuns.paymentDate));
  // NOTE: in this codebase `PaymentRunService.approve` approves AND pays in one step (no bank-file
  // integration exists), so an APPROVED-but-unpaid run is never persisted by the current services. The
  // APPROVED branch is kept so the forecast is correct the moment a real payment-rail integration
  // introduces that state; AWAITING_APPROVAL runs are proposals and only annotate.
  const approvedRunItemsByBill = new Map<string, PaymentRunItemInfo>();
  const awaitingRunItemsByBill = new Map<string, PaymentRunItemInfo>();
  for (const r of runRows) {
    const target = r.status === "APPROVED" ? approvedRunItemsByBill : awaitingRunItemsByBill;
    // A bill in more than one run is attributed to the earliest.
    if (!target.has(r.billId)) {
      target.set(r.billId, { runId: r.runId, runNumber: r.runNumber, paymentDate: r.paymentDate, amount: r.amount });
    }
  }

  const taxRows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate })
    .from(taxCodes)
    .where(eq(taxCodes.organizationId, organizationId));
  const rateByCode = new Map(taxRows.map((t) => [t.id, t.rate]));

  const invTemplates = await tx
    .select({ template: recurringInvoiceTemplates, customer: contacts })
    .from(recurringInvoiceTemplates)
    .innerJoin(contacts, eq(contacts.id, recurringInvoiceTemplates.customerContactId))
    .where(and(eq(recurringInvoiceTemplates.organizationId, organizationId), eq(recurringInvoiceTemplates.isActive, true)))
    .orderBy(asc(recurringInvoiceTemplates.nextRunDate));
  const invLines =
    invTemplates.length === 0
      ? []
      : await tx
          .select()
          .from(recurringInvoiceTemplateLines)
          .where(
            and(
              eq(recurringInvoiceTemplateLines.organizationId, organizationId),
              inArray(recurringInvoiceTemplateLines.templateId, invTemplates.map((t) => t.template.id)),
            ),
          )
          .orderBy(asc(recurringInvoiceTemplateLines.lineNumber));

  const recurringInvoices: TemplateData["recurringInvoices"] = invTemplates.map(({ template, customer }) => {
    const lines = invLines
      .filter((l) => l.templateId === template.id)
      .map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId: l.accountId,
        taxCodeId: l.taxCodeId ?? undefined,
      }));
    try {
      return { template, customerName: customer.displayName, total: calculateInvoiceTotals(lines, currency, rateByCode).total };
    } catch (err) {
      return { template, customerName: customer.displayName, total: null, error: err instanceof Error ? err.message : "invalid template" };
    }
  });

  const billTemplates = await tx
    .select({ template: recurringBillTemplates, supplier: contacts })
    .from(recurringBillTemplates)
    .innerJoin(contacts, eq(contacts.id, recurringBillTemplates.supplierContactId))
    .where(and(eq(recurringBillTemplates.organizationId, organizationId), eq(recurringBillTemplates.isActive, true)))
    .orderBy(asc(recurringBillTemplates.nextRunDate));
  const billLines =
    billTemplates.length === 0
      ? []
      : await tx
          .select()
          .from(recurringBillTemplateLines)
          .where(
            and(
              eq(recurringBillTemplateLines.organizationId, organizationId),
              inArray(recurringBillTemplateLines.templateId, billTemplates.map((t) => t.template.id)),
            ),
          )
          .orderBy(asc(recurringBillTemplateLines.lineNumber));

  const recurringBills: TemplateData["recurringBills"] = billTemplates.map(({ template, supplier }) => {
    const lines = billLines
      .filter((l) => l.templateId === template.id)
      .map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId: l.accountId,
        taxCodeId: l.taxCodeId ?? undefined,
      }));
    try {
      return { template, supplierName: supplier.displayName, total: calculateBillTotals(lines, currency, rateByCode).total };
    } catch (err) {
      return { template, supplierName: supplier.displayName, total: null, error: err instanceof Error ? err.message : "invalid template" };
    }
  });

  // Customers behind an active recurring invoice template that aren't already
  // in the open-invoice history map still get their own settled-invoice
  // history — the same `loadCustomerPaymentHistory` Phase 3 Slice 2's
  // collection priority uses, not a second implementation.
  const customerHistory = new Map(knownHistory);
  for (const { template } of invTemplates) {
    const id = template.customerContactId;
    if (!customerHistory.has(id)) {
      customerHistory.set(id, await loadCustomerPaymentHistory(tx, organizationId, id));
    }
  }

  return { recurringInvoices, recurringBills, customerHistory, approvedRunItemsByBill, awaitingRunItemsByBill, lowCashThreshold };
}

const PAYROLL_KINDS: Array<{ kind: PayrollLiabilityKind; pick: (r: Awaited<ReturnType<typeof PayRunService.listPostedSummaries>>[number]) => string }> = [
  { kind: "NET_WAGES", pick: (r) => r.netWagesPayableAccountId },
  { kind: "PAYG_WITHHOLDING", pick: (r) => r.paygWithholdingPayableAccountId },
  { kind: "SUPERANNUATION", pick: (r) => r.superannuationPayableAccountId },
];

const BASE_CAVEATS = [
  "\"Statistical\" here means simple, explainable averages (a customer's own historical lateness; a repeat of the last pay run) — it is not a forecasting model, and it is shown separately from known commitments on purpose.",
  "Opening cash is the ledger balance of the linked bank accounts, not a live bank feed.",
  "Not modelled: GST/BAS liabilities (no tax-filing domain exists yet), unapplied supplier credits, approved-but-unreimbursed expense claims, and any future sales or expenses not yet invoiced or scheduled. Money in or out that nobody has documented yet is not in either series.",
  "Recurring invoice/bill templates generate DRAFT documents on a human-triggered run; their lines assume the platform's default 30-day payment terms and amounts recomputed from current tax rates.",
  "Base currency only: this forecast does not convert foreign-currency amounts.",
];

/**
 * Master spec §38's Cash Flow Intelligence: a projected cash balance from
 * today across 7/30/60/90-day and 12-month horizons, with **known
 * commitments structurally separated from statistical projections** (see
 * `types.ts`): two series are returned — "known commitments only" and
 * "including statistical projections" — never one blended number.
 *
 * Read-only analysis: no `PostingService` call, no write of any kind.
 *
 * **Permission model.** `forecast:read` is granted only to roles that already
 * hold every underlying read permission (journal, bank account, customer
 * invoice, supplier bill, recurring invoice/bill, payment run — asserted by a
 * unit test over `ROLE_PERMISSIONS`), and each reused service (`loadCashPosition`,
 * `AgedReceivablesService`, `AgedPayablesService`) additionally re-asserts its
 * own permission. **Payroll-derived lines are gated separately on
 * `payrun:read`**, exactly like the Pay Runs page: an actor without it gets a
 * complete forecast with payroll lines OMITTED (and `payrollOmitted: true`),
 * never an error and never a leak of payroll figures through this feature.
 *
 * **DB discipline.** Calls are deliberately sequential — see the
 * EMAXCONNSESSION note in `DailyFinanceBriefService.generate`. This service
 * checks out connections one at a time (cash position: 2, receivables: 2,
 * payables: 1, payroll: 1, one own transaction for everything else) and never
 * fans out in parallel.
 */
export const CashForecastService = {
  async generate(actor: Actor, options: GenerateForecastOptions = {}): Promise<CashForecast> {
    assertPermission(actor, "forecast:read");

    const horizon = options.horizon ?? "90D";
    const horizonDays = HORIZON_DAYS[horizon];
    const granularity = horizon === "12M" ? "WEEKLY" : "DAILY";
    const asOf = startOfUtcDay(options.asOfDate ?? new Date());
    // End of the as-of day, so every ledger posting dated today is in the
    // opening balance regardless of its time component.
    const cashAsOf = new Date(asOf.getTime() + DAY_MS - 1);
    const horizonEnd = addDaysUtc(asOf, horizonDays);

    const cash = options.preloaded?.cashPosition ?? (await loadCashPosition(actor, cashAsOf));
    const receivables = options.preloaded?.receivables ?? (await AgedReceivablesService.getWithPriority(actor, cashAsOf));
    const payables = options.preloaded?.payables ?? (await AgedPayablesService.get(actor, cashAsOf));

    const canSeePayroll = roleHasPermission(actor.role, "payrun:read");
    const postedPayRuns = canSeePayroll ? await PayRunService.listPostedSummaries(actor) : [];

    const knownHistory = new Map<string, { averageDaysLate: number | null; settledInvoiceCount: number }>();
    for (const r of receivables) {
      knownHistory.set(r.customerContactId, { averageDaysLate: r.customerAvgDaysLate, settledInvoiceCount: r.customerSettledInvoiceCount });
    }
    const templates = await withTenant(actor.organizationId, (tx) =>
      loadTemplateData(tx, actor.organizationId, cash.currency, knownHistory),
    );

    const caveats = [...BASE_CAVEATS];
    const lines: ForecastLine[] = [];

    // --- Open customer invoices: KNOWN at the due date (+ STATISTICAL shift) ---
    for (const r of receivables) {
      const { known, statistical } = classifyOpenInvoice(
        {
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          customerName: r.customerName,
          dueDate: r.dueDate,
          outstanding: r.outstanding,
          customerAvgDaysLate: r.customerAvgDaysLate,
          customerSettledInvoiceCount: r.customerSettledInvoiceCount,
        },
        asOf,
      );
      lines.push(known);
      if (statistical) lines.push(statistical);
    }

    // --- Open supplier bills: KNOWN, with APPROVED payment runs replacing the due date ---
    for (const supplier of payables) {
      for (const bill of supplier.bills) {
        const run = templates.approvedRunItemsByBill.get(bill.billId);
        const awaiting = templates.awaitingRunItemsByBill.get(bill.billId);
        const base = {
          billId: bill.billId,
          billNumber: bill.billNumber,
          supplierName: supplier.supplierName,
          dueDate: bill.dueDate,
          awaitingApprovalRun: awaiting ? { runNumber: awaiting.runNumber, paymentDate: awaiting.paymentDate } : undefined,
        };
        if (run) {
          const outstanding = Money.of(bill.outstanding, cash.currency);
          const runAmount = Money.of(run.amount, cash.currency);
          const paidByRun = runAmount.compareTo(outstanding) < 0 ? runAmount : outstanding;
          lines.push(
            classifyOpenBill(
              { ...base, outstanding: paidByRun.toString(), paymentRun: { id: run.runId, runNumber: run.runNumber, paymentDate: run.paymentDate } },
              asOf,
            ),
          );
          const remainder = outstanding.subtract(paidByRun);
          if (remainder.isPositive()) lines.push(classifyOpenBill({ ...base, outstanding: remainder.toString() }, asOf));
        } else {
          lines.push(classifyOpenBill({ ...base, outstanding: bill.outstanding }, asOf));
        }
      }
    }

    // --- Active recurring templates: KNOWN scheduled commitments ---
    for (const t of templates.recurringInvoices) {
      if (t.total === null) {
        caveats.push(`Recurring invoice "${t.template.name}" was left out of the forecast: ${t.error}.`);
        continue;
      }
      const history = templates.customerHistory.get(t.template.customerContactId);
      for (const issueDate of upcomingTemplateIssueDates(t.template, INVOICE_DEFAULT_DUE_DAYS, horizonEnd)) {
        const { known, statistical } = classifyRecurringInvoiceOccurrence(
          {
            templateId: t.template.id,
            templateName: t.template.name,
            counterpartyName: t.customerName,
            issueDate,
            paymentTermsDays: INVOICE_DEFAULT_DUE_DAYS,
            amount: t.total,
            customerAvgDaysLate: history?.averageDaysLate ?? null,
            customerSettledInvoiceCount: history?.settledInvoiceCount ?? null,
          },
          asOf,
        );
        lines.push(known);
        if (statistical) lines.push(statistical);
      }
    }
    for (const t of templates.recurringBills) {
      if (t.total === null) {
        caveats.push(`Recurring bill "${t.template.name}" was left out of the forecast: ${t.error}.`);
        continue;
      }
      for (const issueDate of upcomingTemplateIssueDates(t.template, BILL_DEFAULT_DUE_DAYS, horizonEnd)) {
        lines.push(
          classifyRecurringBillOccurrence(
            {
              templateId: t.template.id,
              templateName: t.template.name,
              counterpartyName: t.supplierName,
              issueDate,
              paymentTermsDays: BILL_DEFAULT_DUE_DAYS,
              amount: t.total,
            },
            asOf,
          ),
        );
      }
    }

    // --- Payroll (only for an actor who may read pay runs) ---
    if (canSeePayroll && postedPayRuns.length > 0) {
      const balanceByAccount = new Map(cash.trialBalance.map((r) => [r.accountId, r]));
      for (const { kind, pick } of PAYROLL_KINDS) {
        const accountIds = [...new Set(postedPayRuns.map(pick))];
        for (const accountId of accountIds) {
          const row = balanceByAccount.get(accountId);
          if (!row) continue;
          const line = buildPayrollLiabilityLine({
            kind,
            accountId,
            accountName: row.name,
            balance: row.balance,
            postedRunCount: postedPayRuns.filter((r) => pick(r) === accountId).length,
          });
          if (line) lines.push(line);
        }
      }
      const last = postedPayRuns[postedPayRuns.length - 1]!;
      lines.push(
        ...projectPayrollNetWages(
          { payRunId: last.id, payDate: last.payDate, payFrequency: last.payFrequency, netPay: last.netPay },
          asOf,
          horizonEnd,
        ),
      );
    }
    if (!canSeePayroll) {
      caveats.push("Payroll-derived lines are omitted because your role cannot read pay runs. Figures may understate outflows.");
    }

    // The series are built from EVERY line (flows past the horizon are ignored by the day-by-day
    // builder, and a statistical line that moves a known line past the horizon must still supersede
    // it). What's RETURNED for display is the horizon's lines — dated lines inside it, every undated
    // known line, and a statistical twin of any visible known line even when its expected date falls
    // beyond the horizon (so the page can show "due in 20 days, expected in 41").
    const horizonEndKey = dateKey(horizonEnd);
    const withinHorizon = (l: ForecastLine) => l.date === null || l.date <= horizonEndKey;
    const knownInHorizon = new Set(lines.filter((l) => l.kind === "KNOWN" && withinHorizon(l)).map((l) => l.id));
    const inHorizon = lines.filter(
      (l) => withinHorizon(l) || (l.kind === "STATISTICAL" && l.replacesLineId !== undefined && knownInHorizon.has(l.replacesLineId)),
    );
    inHorizon.sort((a, b) => (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") || a.kind.localeCompare(b.kind));

    const opening = Money.of(cash.total, cash.currency);
    const known = buildSeries(opening, lines, "KNOWN_ONLY", asOf, horizonDays, granularity);
    const stat = buildSeries(opening, lines, "INCLUDING_STATISTICAL", asOf, horizonDays, granularity);
    const warning = buildLowCashWarning(known.daily, stat.daily, templates.lowCashThreshold, cash.currency, asOf);

    const undated = inHorizon.filter((l): l is KnownForecastLine => l.kind === "KNOWN" && l.date === null);
    const sum = (dir: "IN" | "OUT") =>
      undated.filter((l) => l.direction === dir).reduce((s, l) => s.add(Money.of(l.amount, cash.currency)), Money.zero(cash.currency));
    const unscheduledOut = sum("OUT");

    return {
      asOf: dateKey(asOf),
      currency: cash.currency,
      horizon,
      horizonDays,
      granularity,
      openingCash: {
        total: cash.total,
        accounts: cash.accounts.map((a) => ({ ...a })),
      },
      lowCashThreshold: Money.of(templates.lowCashThreshold, cash.currency).toString(),
      knownOnly: known.series,
      withStatistical: stat.series,
      warning,
      unscheduledKnown: {
        inflows: sum("IN").toString(),
        outflows: unscheduledOut.toString(),
        lineIds: undated.map((l) => l.id),
        lowPointIfUnscheduledOutflowsPaidNow: lowPointIfUnscheduledOutflowsPaidNow(known.daily, unscheduledOut),
      },
      lines: inHorizon,
      payrollOmitted: !canSeePayroll,
      caveats,
    };
  },
};
