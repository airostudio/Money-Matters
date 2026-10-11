import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import Decimal from "decimal.js";
import {
  accounts,
  basLodgementRecords,
  basStatements,
  billLines,
  bills,
  customerCreditNoteLines,
  customerCreditNotes,
  expenseClaimLines,
  expenseClaims,
  fiscalPeriods,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  payRunLines,
  payRuns,
  supplierCreditNoteLines,
  supplierCreditNotes,
  taxCodes,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { monthBounds, monthKey } from "@/domain/close/period-ref";
import {
  BAS_BASIS_SUPPORTED,
  BAS_DISCLAIMER,
  classifyLine,
  computeBasFigures,
  contentHash,
  periodBounds,
  reconcileToControlAccounts,
  type BasDocType,
  type BasFigures,
  type BasGstTreatment,
  type BasReconciliation,
  type BasSourceLine,
  type ClassifiedSourceLine,
  type ControlAccountActivity,
  type PayrollSourceLine,
} from "./bas-calculations";
import {
  BasBasisNotSupportedError,
  BasInvalidPeriodError,
  BasNotDraftError,
  BasNotFinalisedError,
  BasNotFoundError,
  BasWarningsNotAcknowledgedError,
} from "./bas-errors";

export type BasStatementRow = typeof basStatements.$inferSelect;

export interface AdHocTaxCodedLine {
  journalEntryId: string;
  entryNumber: string;
  postingDate: string;
  accountCode: string;
  taxCode: string;
  treatment: BasGstTreatment | null;
  amount: string;
}

export interface NonDocumentControlLine {
  journalEntryId: string;
  entryNumber: string;
  postingDate: string;
  memo: string | null;
  accountCode: string;
  debit: string;
  credit: string;
}

export interface BasPeriodLock {
  months: Array<{ key: string; level: string }>;
  /** True when every calendar month in the period has a fiscal period row locked at ADVISOR_LOCKED or stricter. */
  allLocked: boolean;
}

export interface BasReport {
  schemaVersion: 1;
  baseCurrency: string;
  periodStart: string;
  periodEnd: string;
  basis: typeof BAS_BASIS_SUPPORTED;
  figures: BasFigures;
  sources: ClassifiedSourceLine[];
  payroll: PayrollSourceLine[];
  reconciliation: BasReconciliation;
  nonDocumentControlLines: NonDocumentControlLine[];
  adHocTaxCodedLines: { count: number; totalAmount: string; shown: AdHocTaxCodedLine[] };
  periodLock: BasPeriodLock;
  warnings: string[];
  disclaimer: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const MAX_AD_HOC_SHOWN = 50;
const MAX_NON_DOC_SHOWN = 100;
const STRICT_LOCKS = new Set(["ADVISOR_LOCKED", "TAX_LOCKED", "HARD_LOCKED"]);

interface EventRow {
  jeId: string;
  jeDate: Date;
  revId: string | null;
  revDate: Date | null;
}

function eventsFor(row: EventRow, from: Date, to: Date): Array<{ event: "POSTING" | "REVERSAL"; date: Date; jeId: string }> {
  const out: Array<{ event: "POSTING" | "REVERSAL"; date: Date; jeId: string }> = [];
  if (row.jeDate >= from && row.jeDate <= to) out.push({ event: "POSTING", date: row.jeDate, jeId: row.jeId });
  if (row.revId && row.revDate && row.revDate >= from && row.revDate <= to) {
    out.push({ event: "REVERSAL", date: row.revDate, jeId: row.revId });
  }
  return out;
}

function toSource(
  base: Omit<BasSourceLine, "sign" | "event" | "postingDate" | "journalEntryId">,
  ev: { event: "POSTING" | "REVERSAL"; date: Date; jeId: string },
  creditNote: boolean,
): BasSourceLine {
  const baseSign = creditNote ? -1 : 1;
  const sign = (ev.event === "REVERSAL" ? -baseSign : baseSign) as 1 | -1;
  return { ...base, sign, event: ev.event, postingDate: iso(ev.date), journalEntryId: ev.jeId };
}

/**
 * Collects every document line whose posting journal (or the reversal of that journal) is dated inside the period.
 * ACCRUAL basis: a document counts in the period its journal is posted; a void / reversal counts as a negative
 * adjustment in the period the reversal journal is dated - exactly how the ledger itself treats it.
 */
async function collectDocumentLines(
  tx: TenantDb,
  organizationId: string,
  baseCurrency: string,
  from: Date,
  to: Date,
): Promise<BasSourceLine[]> {
  const je = alias(journalEntries, "je");
  const rev = alias(journalEntries, "rev");
  const inRange = or(
    and(gte(je.postingDate, from), lte(je.postingDate, to)),
    and(gte(rev.postingDate, from), lte(rev.postingDate, to)),
  );
  const out: BasSourceLine[] = [];

  const inv = await tx
    .select({
      line: invoiceLines,
      docId: invoices.id,
      docNumber: invoices.invoiceNumber,
      currency: invoices.currency,
      jeId: je.id,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      tcCode: taxCodes.code,
      tcTreatment: taxCodes.basTreatment,
      tcCapital: taxCodes.basCapital,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .innerJoin(je, eq(je.id, invoices.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .leftJoin(taxCodes, eq(taxCodes.id, invoiceLines.taxCodeId))
    .where(and(eq(invoices.organizationId, organizationId), inRange))
    .orderBy(asc(invoices.invoiceNumber), asc(invoiceLines.lineNumber));
  for (const r of inv) {
    for (const ev of eventsFor(r as EventRow, from, to)) {
      out.push(
        toSource(
          {
            docType: "INVOICE",
            docId: r.docId,
            docNumber: r.docNumber,
            lineId: r.line.id,
            lineNumber: r.line.lineNumber,
            description: r.line.description,
            side: "SALE",
            taxCodeId: r.line.taxCodeId,
            taxCodeCode: r.tcCode,
            treatment: r.tcTreatment,
            capital: r.tcCapital ?? false,
            net: r.line.lineAmount,
            gst: r.line.taxAmount,
            foreignCurrency: r.currency !== baseCurrency,
          },
          ev,
          false,
        ),
      );
    }
  }

  // Customer credit notes (sales documents slice): a SALE-side document that REDUCES sales, so it enters with a
  // negative sign (G1 and 1A fall by its net and GST); voiding it reverses that in the period the reversal is dated.
  const ccn = await tx
    .select({
      line: customerCreditNoteLines,
      docId: customerCreditNotes.id,
      docNumber: customerCreditNotes.creditNoteNumber,
      currency: customerCreditNotes.currency,
      jeId: je.id,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      tcCode: taxCodes.code,
      tcTreatment: taxCodes.basTreatment,
      tcCapital: taxCodes.basCapital,
    })
    .from(customerCreditNoteLines)
    .innerJoin(customerCreditNotes, eq(customerCreditNotes.id, customerCreditNoteLines.creditNoteId))
    .innerJoin(je, eq(je.id, customerCreditNotes.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .leftJoin(taxCodes, eq(taxCodes.id, customerCreditNoteLines.taxCodeId))
    .where(and(eq(customerCreditNotes.organizationId, organizationId), inRange))
    .orderBy(asc(customerCreditNotes.creditNoteNumber), asc(customerCreditNoteLines.lineNumber));
  for (const r of ccn) {
    for (const ev of eventsFor(r as EventRow, from, to)) {
      out.push(
        toSource(
          {
            docType: "CUSTOMER_CREDIT",
            docId: r.docId,
            docNumber: r.docNumber,
            lineId: r.line.id,
            lineNumber: r.line.lineNumber,
            description: r.line.description,
            side: "SALE",
            taxCodeId: r.line.taxCodeId,
            taxCodeCode: r.tcCode,
            treatment: r.tcTreatment,
            capital: r.tcCapital ?? false,
            net: r.line.lineAmount,
            gst: r.line.taxAmount,
            foreignCurrency: r.currency !== baseCurrency,
          },
          ev,
          true,
        ),
      );
    }
  }

  const bil = await tx
    .select({
      line: billLines,
      docId: bills.id,
      docNumber: bills.billNumber,
      currency: bills.currency,
      jeId: je.id,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      tcCode: taxCodes.code,
      tcTreatment: taxCodes.basTreatment,
      tcCapital: taxCodes.basCapital,
    })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .innerJoin(je, eq(je.id, bills.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .leftJoin(taxCodes, eq(taxCodes.id, billLines.taxCodeId))
    .where(and(eq(bills.organizationId, organizationId), inRange))
    .orderBy(asc(bills.billNumber), asc(billLines.lineNumber));
  for (const r of bil) {
    for (const ev of eventsFor(r as EventRow, from, to)) {
      out.push(
        toSource(
          {
            docType: "BILL",
            docId: r.docId,
            docNumber: r.docNumber,
            lineId: r.line.id,
            lineNumber: r.line.lineNumber,
            description: r.line.description,
            side: "PURCHASE",
            taxCodeId: r.line.taxCodeId,
            taxCodeCode: r.tcCode,
            treatment: r.tcTreatment,
            capital: r.tcCapital ?? false,
            net: r.line.lineAmount,
            gst: r.line.taxAmount,
            foreignCurrency: r.currency !== baseCurrency,
          },
          ev,
          false,
        ),
      );
    }
  }

  const cre = await tx
    .select({
      line: supplierCreditNoteLines,
      docId: supplierCreditNotes.id,
      docNumber: supplierCreditNotes.creditNoteNumber,
      currency: supplierCreditNotes.currency,
      jeId: je.id,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      tcCode: taxCodes.code,
      tcTreatment: taxCodes.basTreatment,
      tcCapital: taxCodes.basCapital,
    })
    .from(supplierCreditNoteLines)
    .innerJoin(supplierCreditNotes, eq(supplierCreditNotes.id, supplierCreditNoteLines.creditNoteId))
    .innerJoin(je, eq(je.id, supplierCreditNotes.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .leftJoin(taxCodes, eq(taxCodes.id, supplierCreditNoteLines.taxCodeId))
    .where(and(eq(supplierCreditNotes.organizationId, organizationId), inRange))
    .orderBy(asc(supplierCreditNotes.creditNoteNumber), asc(supplierCreditNoteLines.lineNumber));
  for (const r of cre) {
    for (const ev of eventsFor(r as EventRow, from, to)) {
      out.push(
        toSource(
          {
            docType: "SUPPLIER_CREDIT",
            docId: r.docId,
            docNumber: r.docNumber,
            lineId: r.line.id,
            lineNumber: r.line.lineNumber,
            description: r.line.description,
            side: "PURCHASE",
            taxCodeId: r.line.taxCodeId,
            taxCodeCode: r.tcCode,
            treatment: r.tcTreatment,
            capital: r.tcCapital ?? false,
            net: r.line.lineAmount,
            gst: r.line.taxAmount,
            foreignCurrency: r.currency !== baseCurrency,
          },
          ev,
          true,
        ),
      );
    }
  }

  const exp = await tx
    .select({
      line: expenseClaimLines,
      docId: expenseClaims.id,
      docNumber: expenseClaims.claimNumber,
      currency: expenseClaims.currency,
      jeId: je.id,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      tcCode: taxCodes.code,
      tcTreatment: taxCodes.basTreatment,
      tcCapital: taxCodes.basCapital,
    })
    .from(expenseClaimLines)
    .innerJoin(expenseClaims, eq(expenseClaims.id, expenseClaimLines.expenseClaimId))
    .innerJoin(je, eq(je.id, expenseClaims.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .leftJoin(taxCodes, eq(taxCodes.id, expenseClaimLines.taxCodeId))
    .where(and(eq(expenseClaims.organizationId, organizationId), inRange))
    .orderBy(asc(expenseClaims.claimNumber), asc(expenseClaimLines.lineNumber));
  for (const r of exp) {
    for (const ev of eventsFor(r as EventRow, from, to)) {
      out.push(
        toSource(
          {
            docType: "EXPENSE_CLAIM",
            docId: r.docId,
            docNumber: r.docNumber,
            lineId: r.line.id,
            lineNumber: r.line.lineNumber,
            description: r.line.description,
            side: "PURCHASE",
            taxCodeId: r.line.taxCodeId,
            taxCodeCode: r.tcCode,
            treatment: r.tcTreatment,
            capital: r.tcCapital ?? false,
            net: r.line.amount,
            gst: r.line.taxAmount,
            foreignCurrency: r.currency !== baseCurrency,
          },
          ev,
          false,
        ),
      );
    }
  }

  return out;
}

/**
 * W1 / W2 from pay runs whose posting journal is dated in the period (a POSTED or since-REVERSED run); a reversed run
 * is a NEGATIVE in the period its reversal journal is dated - the same treatment as documents.
 */
async function collectPayroll(tx: TenantDb, organizationId: string, from: Date, to: Date): Promise<PayrollSourceLine[]> {
  const out: PayrollSourceLine[] = [];
  const je = alias(journalEntries, "je");
  const rev = alias(journalEntries, "rev");
  const rows = await tx
    .select({
      id: payRuns.id,
      payDate: payRuns.payDate,
      periodStart: payRuns.periodStart,
      periodEnd: payRuns.periodEnd,
      jeDate: je.postingDate,
      revId: rev.id,
      revDate: rev.postingDate,
      gross: sql<string>`coalesce(sum(${payRunLines.grossPay}), 0)`,
      payg: sql<string>`coalesce(sum(${payRunLines.paygWithholding}), 0)`,
    })
    .from(payRuns)
    .innerJoin(payRunLines, eq(payRunLines.payRunId, payRuns.id))
    .innerJoin(je, eq(je.id, payRuns.journalEntryId))
    .leftJoin(rev, eq(rev.reversalOfId, je.id))
    .where(
      and(
        eq(payRuns.organizationId, organizationId),
        or(
          and(gte(je.postingDate, from), lte(je.postingDate, to)),
          and(gte(rev.postingDate, from), lte(rev.postingDate, to)),
        ),
      ),
    )
    .groupBy(payRuns.id, je.id, rev.id)
    .orderBy(asc(je.postingDate));
  for (const r of rows) {
    const base = {
      payRunId: r.id,
      periodStart: iso(r.periodStart),
      periodEnd: iso(r.periodEnd),
      gross: new Decimal(r.gross).toFixed(4),
      payg: new Decimal(r.payg).toFixed(4),
    };
    if (r.jeDate >= from && r.jeDate <= to) {
      out.push({ ...base, payDate: iso(r.jeDate), event: "POSTING", sign: 1 });
    }
    if (r.revId && r.revDate && r.revDate >= from && r.revDate <= to) {
      out.push({ ...base, payDate: iso(r.revDate), event: "REVERSAL", sign: -1 });
    }
  }
  return out;
}

async function loadPeriodLock(tx: TenantDb, organizationId: string, startIso: string, endIso: string): Promise<BasPeriodLock> {
  const rows = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.organizationId, organizationId));
  const months: Array<{ key: string; level: string }> = [];
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  while (new Date(Date.UTC(y, m - 1, 1)) <= end) {
    const key = monthKey(y, m);
    const b = monthBounds(y, m);
    const row =
      rows.find((r) => r.label === key) ??
      rows.find((r) => r.startDate.getTime() === b.start.getTime() && r.endDate.getTime() === b.end.getTime());
    months.push({ key, level: row?.status ?? "OPEN" });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return { months, allLocked: months.length > 0 && months.every((x) => STRICT_LOCKS.has(x.level)) };
}

/** Computes the full BAS report for a period from posted data. Read-only. */
export async function computeBasReport(
  tx: TenantDb,
  organizationId: string,
  startIso: string,
  endIso: string,
): Promise<BasReport> {
  const { from, to } = periodBounds(startIso, endIso);
  const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, organizationId));
  const baseCurrency = org?.baseCurrency ?? "AUD";

  const rawLines = await collectDocumentLines(tx, organizationId, baseCurrency, from, to);
  const sources = rawLines.map(classifyLine);
  const payroll = await collectPayroll(tx, organizationId, from, to);
  const figures = computeBasFigures(sources, payroll);

  // --- GST control accounts -------------------------------------------------
  const codes = await tx
    .select({ payable: taxCodes.payableAccountId, receivable: taxCodes.receivableAccountId })
    .from(taxCodes)
    .where(eq(taxCodes.organizationId, organizationId));
  const salesAccountIds = new Set(codes.map((c) => c.payable).filter((x): x is string => !!x));
  const purchaseAccountIds = new Set(
    codes.map((c) => c.receivable).filter((x): x is string => !!x && !salesAccountIds.has(x)),
  );
  const controlIds = [...salesAccountIds, ...purchaseAccountIds];
  const activity: ControlAccountActivity[] = [];
  const nonDocumentControlLines: NonDocumentControlLine[] = [];
  if (controlIds.length > 0) {
    const sums = await tx
      .select({
        accountId: journalLines.accountId,
        code: accounts.code,
        name: accounts.name,
        debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalEntries.organizationId, organizationId),
          ne(journalEntries.status, "DRAFT"),
          gte(journalEntries.postingDate, from),
          lte(journalEntries.postingDate, to),
          inArray(journalLines.accountId, controlIds),
        ),
      )
      .groupBy(journalLines.accountId, accounts.code, accounts.name);
    const byId = new Map(sums.map((s) => [s.accountId, s]));
    const accountMeta = await tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, controlIds)));
    for (const a of accountMeta.sort((x, y) => x.code.localeCompare(y.code))) {
      const s = byId.get(a.id);
      activity.push({
        accountId: a.id,
        code: a.code,
        name: a.name,
        role: salesAccountIds.has(a.id) ? "SALES_GST" : "PURCHASES_GST",
        debit: s?.debit ?? "0",
        credit: s?.credit ?? "0",
      });
    }

    const sourceEntryIds = new Set(sources.map((s) => s.journalEntryId));
    const lines = await tx
      .select({
        entryId: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        postingDate: journalEntries.postingDate,
        memo: journalEntries.memo,
        code: accounts.code,
        debit: journalLines.baseDebit,
        credit: journalLines.baseCredit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalEntries.organizationId, organizationId),
          ne(journalEntries.status, "DRAFT"),
          gte(journalEntries.postingDate, from),
          lte(journalEntries.postingDate, to),
          inArray(journalLines.accountId, controlIds),
        ),
      )
      .orderBy(asc(journalEntries.postingDate), asc(journalEntries.entryNumber));
    for (const l of lines) {
      if (sourceEntryIds.has(l.entryId)) continue;
      if (nonDocumentControlLines.length >= MAX_NON_DOC_SHOWN) break;
      nonDocumentControlLines.push({
        journalEntryId: l.entryId,
        entryNumber: l.entryNumber,
        postingDate: iso(l.postingDate),
        memo: l.memo,
        accountCode: l.code,
        debit: l.debit,
        credit: l.credit,
      });
    }
  }
  const reconciliation = reconcileToControlAccounts(activity, figures);

  // --- Journal lines carrying a tax code that the ledger never split GST out of ------------------------------
  const adHoc = await tx
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      postingDate: journalEntries.postingDate,
      accountCode: accounts.code,
      taxCode: taxCodes.code,
      treatment: taxCodes.basTreatment,
      amount: sql<string>`(${journalLines.baseDebit} + ${journalLines.baseCredit})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(taxCodes, eq(taxCodes.id, journalLines.taxCodeId))
    .where(
      and(
        eq(journalEntries.organizationId, organizationId),
        ne(journalEntries.status, "DRAFT"),
        gte(journalEntries.postingDate, from),
        lte(journalEntries.postingDate, to),
        isNotNull(journalLines.taxCodeId),
      ),
    )
    .orderBy(asc(journalEntries.postingDate), asc(journalEntries.entryNumber));
  let adHocTotal = new Decimal(0);
  for (const a of adHoc) adHocTotal = adHocTotal.plus(a.amount);
  const adHocLines: AdHocTaxCodedLine[] = adHoc.slice(0, MAX_AD_HOC_SHOWN).map((a) => ({
    journalEntryId: a.entryId,
    entryNumber: a.entryNumber,
    postingDate: iso(a.postingDate),
    accountCode: a.accountCode,
    taxCode: a.taxCode,
    treatment: a.treatment,
    amount: a.amount,
  }));

  const periodLock = await loadPeriodLock(tx, organizationId, startIso, endIso);

  const warnings: string[] = [];
  const u = figures.unclassified;
  if (u.sales.count > 0) {
    warnings.push(
      `${u.sales.count} sales line(s) could not be classified (no tax code, an unclassified tax code, a foreign-currency document or GST on a non-taxable code) and are NOT included in G1/G2/G3/1A.`,
    );
  }
  if (u.purchases.count > 0) {
    warnings.push(
      `${u.purchases.count} purchase line(s) could not be classified and are NOT included in G10/G11/1B.`,
    );
  }
  if (adHoc.length > 0) {
    warnings.push(
      `${adHoc.length} journal line(s) carry a tax code, but the ledger posted the full amount to one account without a GST split (e.g. bank-coded transactions). They are NOT included in any label - review them.`,
    );
  }
  if (reconciliation.variance !== "0.0000") {
    warnings.push(
      `GST control accounts differ from the BAS by ${reconciliation.variance} (ledger net GST ${reconciliation.ledgerNet} vs BAS ${reconciliation.basNet}). The variance is shown, never plugged.`,
    );
  }
  if (!periodLock.allLocked) {
    warnings.push(
      "The period is not fully closed/locked (every month needs a fiscal period at ADVISOR_LOCKED or stricter). Postings can still change these figures.",
    );
  }
  if (activity.length === 0) {
    warnings.push("No GST control accounts are configured on any tax code, so no ledger reconciliation was possible.");
  }

  return {
    schemaVersion: 1,
    baseCurrency,
    periodStart: startIso,
    periodEnd: endIso,
    basis: BAS_BASIS_SUPPORTED,
    figures,
    sources,
    payroll,
    reconciliation,
    nonDocumentControlLines,
    adHocTaxCodedLines: { count: adHoc.length, totalAmount: adHocTotal.toFixed(4), shown: adHocLines },
    periodLock,
    warnings,
    disclaimer: BAS_DISCLAIMER,
  };
}

function validatePeriod(startIso: string, endIso: string, frequency: "MONTHLY" | "QUARTERLY"): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) {
    throw new BasInvalidPeriodError("Period dates must be YYYY-MM-DD.");
  }
  const s = new Date(`${startIso}T00:00:00Z`);
  const e = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) {
    throw new BasInvalidPeriodError("The period end must not be before the start.");
  }
  const days = (e.getTime() - s.getTime()) / 86400000 + 1;
  const max = frequency === "MONTHLY" ? 31 : 92;
  if (days > max) throw new BasInvalidPeriodError(`A ${frequency.toLowerCase()} BAS period cannot exceed ${max} days.`);
}

function assertHuman(actor: Actor, permission: "bas:finalise" | "bas:manage"): void {
  assertPermission(actor, permission);
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError(permission, actor.role);
}

async function loadStatement(tx: TenantDb, organizationId: string, id: string): Promise<BasStatementRow> {
  const [row] = await tx
    .select()
    .from(basStatements)
    .where(and(eq(basStatements.id, id), eq(basStatements.organizationId, organizationId)));
  if (!row) throw new BasNotFoundError(id);
  return row;
}

export interface BasStatementView {
  statement: BasStatementRow;
  report: BasReport;
  /** FINALISED only: the stored hash matches a recomputation over the stored snapshot. */
  hashVerified: boolean | null;
  /** FINALISED only: labels whose LIVE value now differs from the snapshot (ledger changed after finalising). */
  liveDrift: Array<{ label: string; snapshot: string; live: string }> | null;
  lodgements: Array<typeof basLodgementRecords.$inferSelect>;
}

export const BasService = {
  async list(actor: Actor): Promise<BasStatementRow[]> {
    assertPermission(actor, "bas:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(basStatements)
        .where(eq(basStatements.organizationId, actor.organizationId))
        .orderBy(desc(basStatements.periodStart), desc(basStatements.createdAt)),
    );
  },

  /** Computes a report without saving anything (used by the AI summary tool and the new-BAS preview). */
  async preview(actor: Actor, input: { periodStart: string; periodEnd: string; frequency: "MONTHLY" | "QUARTERLY" }): Promise<BasReport> {
    assertPermission(actor, "bas:read");
    validatePeriod(input.periodStart, input.periodEnd, input.frequency);
    return withTenant(actor.organizationId, (tx) =>
      computeBasReport(tx, actor.organizationId, input.periodStart, input.periodEnd),
    );
  },

  async createDraft(
    actor: Actor,
    input: { periodStart: string; periodEnd: string; frequency: "MONTHLY" | "QUARTERLY"; basis?: string; note?: string },
  ): Promise<BasStatementRow> {
    assertPermission(actor, "bas:manage");
    if ((input.basis ?? "ACCRUAL") !== BAS_BASIS_SUPPORTED) throw new BasBasisNotSupportedError(input.basis ?? "");
    validatePeriod(input.periodStart, input.periodEnd, input.frequency);
    const { from } = periodBounds(input.periodStart, input.periodEnd);
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .insert(basStatements)
        .values({
          organizationId: actor.organizationId,
          periodStart: from,
          periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
          frequency: input.frequency,
          basis: BAS_BASIS_SUPPORTED,
          note: input.note?.trim() || null,
          createdById: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create BAS draft.");
      await AuditService.record(tx, actor, {
        action: "bas.draft_created",
        entityType: "BasStatement",
        entityId: row.id,
        after: { periodStart: input.periodStart, periodEnd: input.periodEnd, frequency: input.frequency },
      });
      return row;
    });
  },

  async deleteDraft(actor: Actor, id: string): Promise<void> {
    assertPermission(actor, "bas:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const row = await loadStatement(tx, actor.organizationId, id);
      if (row.status !== "DRAFT") throw new BasNotDraftError(id);
      await tx.delete(basStatements).where(eq(basStatements.id, id));
      await AuditService.record(tx, actor, {
        action: "bas.draft_deleted",
        entityType: "BasStatement",
        entityId: id,
        before: { status: "DRAFT" },
      });
    });
  },

  /**
   * DRAFT: the report is recomputed live. FINALISED: the stored immutable snapshot is returned, with a hash
   * verification and a drift comparison against the live ledger.
   */
  async get(actor: Actor, id: string): Promise<BasStatementView> {
    assertPermission(actor, "bas:read");
    return withTenant(actor.organizationId, async (tx) => {
      const statement = await loadStatement(tx, actor.organizationId, id);
      const startIso = iso(statement.periodStart);
      const endIso = iso(statement.periodEnd);
      const lodgements = await tx
        .select()
        .from(basLodgementRecords)
        .where(and(eq(basLodgementRecords.organizationId, actor.organizationId), eq(basLodgementRecords.basStatementId, id)))
        .orderBy(asc(basLodgementRecords.createdAt));
      if (statement.status === "DRAFT" || !statement.report) {
        const report = await computeBasReport(tx, actor.organizationId, startIso, endIso);
        return { statement, report, hashVerified: null, liveDrift: null, lodgements };
      }
      const snapshot = statement.report as BasReport;
      const hashVerified = contentHash(snapshot) === statement.contentHash;
      const live = await computeBasReport(tx, actor.organizationId, startIso, endIso);
      const liveDrift: Array<{ label: string; snapshot: string; live: string }> = [];
      for (const label of Object.keys(snapshot.figures.labels) as Array<keyof BasFigures["labels"]>) {
        if (snapshot.figures.labels[label] !== live.figures.labels[label]) {
          liveDrift.push({ label, snapshot: snapshot.figures.labels[label], live: live.figures.labels[label] });
        }
      }
      return { statement, report: snapshot, hashVerified, liveDrift, lodgements };
    });
  },

  /**
   * Snapshots the figures immutably (HUMAN only, `bas:finalise`). Outstanding warnings (unclassified amounts, an
   * unlocked period, a control-account variance) must be explicitly acknowledged. After this, the row cannot be
   * updated or deleted by the application role (RLS UPDATE/DELETE policies match DRAFT rows only).
   */
  async finalise(actor: Actor, id: string, opts: { acknowledgeWarnings?: boolean } = {}): Promise<BasStatementRow> {
    assertHuman(actor, "bas:finalise");
    return withTenant(actor.organizationId, async (tx) => {
      const statement = await loadStatement(tx, actor.organizationId, id);
      if (statement.status !== "DRAFT") throw new BasNotDraftError(id);
      const report = await computeBasReport(tx, actor.organizationId, iso(statement.periodStart), iso(statement.periodEnd));
      if (report.warnings.length > 0 && !opts.acknowledgeWarnings) {
        throw new BasWarningsNotAcknowledgedError(report.warnings);
      }
      const hash = contentHash(report);
      const worst = report.periodLock.months.map((m) => m.level).join(",");
      const [updated] = await tx
        .update(basStatements)
        .set({
          status: "FINALISED",
          report: report as unknown as Record<string, unknown>,
          contentHash: hash,
          warningsAcknowledged: report.warnings.length > 0,
          periodLockAtFinalise: worst,
          finalisedAt: new Date(),
          finalisedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(basStatements.id, id), eq(basStatements.status, "DRAFT")))
        .returning();
      if (!updated) throw new BasNotDraftError(id);
      await AuditService.record(tx, actor, {
        action: "bas.finalised",
        entityType: "BasStatement",
        entityId: id,
        before: { status: "DRAFT" },
        after: {
          status: "FINALISED",
          contentHash: hash,
          labels: report.figures.labels,
          warningsAcknowledged: report.warnings.length,
          periodLock: worst,
        },
      });
      return updated;
    });
  },

  /**
   * Records that a FINALISED BAS was lodged OUTSIDE Money Matters. Nothing is transmitted and the reference is not
   * verified: it is a bookkeeping note (append-only).
   */
  async markLodgedOutside(actor: Actor, id: string, input: { lodgedOn: string; reference: string }) {
    assertHuman(actor, "bas:finalise");
    const reference = input.reference.trim();
    if (!reference) throw new BasInvalidPeriodError("A lodgement reference is required.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.lodgedOn)) throw new BasInvalidPeriodError("Lodgement date must be YYYY-MM-DD.");
    return withTenant(actor.organizationId, async (tx) => {
      const statement = await loadStatement(tx, actor.organizationId, id);
      if (statement.status !== "FINALISED") throw new BasNotFinalisedError(id);
      const [rec] = await tx
        .insert(basLodgementRecords)
        .values({
          organizationId: actor.organizationId,
          basStatementId: id,
          lodgedOn: new Date(`${input.lodgedOn}T00:00:00.000Z`),
          reference,
          recordedById: actor.userId,
        })
        .returning();
      if (!rec) throw new Error("Failed to record lodgement.");
      await AuditService.record(tx, actor, {
        action: "bas.lodgement_recorded",
        entityType: "BasStatement",
        entityId: id,
        after: { lodgedOn: input.lodgedOn, reference, note: "Lodged outside Money Matters; not verified." },
      });
      return rec;
    });
  },
};

export type { BasDocType };
