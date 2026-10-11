import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accounts,
  contacts,
  customerCreditAllocations,
  customerCreditNotes,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  paymentAllocations,
  payments,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AGING_BUCKETS, bucketFor, daysBetween, type AgingBucket } from "./aged-receivables-service";
import { InvalidContactForInvoiceError, StatementRangeError } from "./errors";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const MAX_RANGE_DAYS = 366 * 5;

export type StatementLineType = "INVOICE" | "INVOICE_VOID" | "CREDIT_NOTE" | "CREDIT_NOTE_VOID" | "PAYMENT";

export interface StatementLine {
  date: string;
  type: StatementLineType;
  number: string;
  description: string;
  /** Increases what the customer owes (an invoice, or the reversal of a credit note). */
  charge: string;
  /** Reduces what the customer owes (a payment, a credit note, or the reversal of an invoice). */
  credit: string;
  /** Running balance after this line, starting from the opening balance. */
  balance: string;
  documentId: string;
}

export interface StatementAgedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: string;
  outstanding: string;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface StatementUnappliedCredit {
  kind: "CREDIT_NOTE" | "PAYMENT";
  id: string;
  label: string;
  date: string;
  remaining: string;
}

export interface Statement {
  organizationName: string;
  customer: { id: string; name: string; email: string | null; taxNumber: string | null };
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  lines: StatementLine[];
  totalCharges: string;
  totalCredits: string;
  closingBalance: string;
  aging: {
    asAt: string;
    buckets: Record<AgingBucket, string>;
    openInvoices: StatementAgedInvoice[];
    openInvoicesTotal: string;
    unappliedCredits: StatementUnappliedCredit[];
    unappliedCreditsTotal: string;
    /** Open invoices minus unapplied credits. */
    total: string;
  };
  /**
   * The statement's closing balance is built from DOCUMENTS (invoices, credit notes, payments); the aged summary is
   * built independently from ALLOCATIONS (what is still open). They must agree; if they do not, `variance` shows by how
   * much - it is reported, never plugged.
   */
  reconciliation: { closingBalance: string; agedTotal: string; variance: string; reconciled: boolean };
  /** Documents in another currency than the statement's, left out of every figure above. */
  excludedForeignCurrencyDocuments: number;
}

function parseDay(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StatementRangeError(`${label} must be a date (YYYY-MM-DD).`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || iso(d) !== value) throw new StatementRangeError(`${label} is not a real date.`);
  return d;
}

interface Event {
  date: string;
  seq: number;
  line: Omit<StatementLine, "balance">;
}

async function loadStatement(
  tx: TenantDb,
  organizationId: string,
  customerId: string,
  fromIso: string,
  toIso: string,
  currencyOverride?: string,
): Promise<Statement> {
  const from = parseDay(fromIso, "From date");
  const to = parseDay(toIso, "To date");
  if (from.getTime() > to.getTime()) throw new StatementRangeError("The From date must not be after the To date.");
  if (daysBetween(to, from) > MAX_RANGE_DAYS) throw new StatementRangeError("A statement can cover at most five years.");

  const [customer] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, customerId), eq(contacts.organizationId, organizationId)));
  if (!customer || (customer.kind !== "CUSTOMER" && customer.kind !== "BOTH")) throw new InvalidContactForInvoiceError(customerId);
  const [org] = await tx
    .select({ name: organizations.name, baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const currency = currencyOverride ?? org?.baseCurrency ?? "AUD";

  const voidJe = alias(journalEntries, "void_je");

  const invoiceRows = await tx
    .select({ invoice: invoices, voidDate: voidJe.postingDate })
    .from(invoices)
    .leftJoin(voidJe, eq(voidJe.id, invoices.voidJournalEntryId))
    .where(and(eq(invoices.organizationId, organizationId), eq(invoices.customerContactId, customerId), ne(invoices.status, "DRAFT")));
  const creditRows = await tx
    .select({ credit: customerCreditNotes, voidDate: voidJe.postingDate })
    .from(customerCreditNotes)
    .leftJoin(voidJe, eq(voidJe.id, customerCreditNotes.voidJournalEntryId))
    .where(
      and(
        eq(customerCreditNotes.organizationId, organizationId),
        eq(customerCreditNotes.customerContactId, customerId),
        ne(customerCreditNotes.status, "DRAFT"),
      ),
    );
  const paymentRows = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.customerContactId, customerId)));

  const paymentIds = paymentRows.map((p) => p.id);
  const payAllocs =
    paymentIds.length === 0
      ? []
      : await tx
          .select({
            paymentId: paymentAllocations.paymentId,
            invoiceId: paymentAllocations.invoiceId,
            amount: paymentAllocations.amount,
            effective: sql<Date>`coalesce(${paymentAllocations.appliedDate}, ${payments.paymentDate})`,
          })
          .from(paymentAllocations)
          .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
          .where(and(eq(paymentAllocations.organizationId, organizationId), inArray(paymentAllocations.paymentId, paymentIds)));
  const creditIds = creditRows.map((c) => c.credit.id);
  const creditAllocs =
    creditIds.length === 0
      ? []
      : await tx
          .select()
          .from(customerCreditAllocations)
          .where(and(eq(customerCreditAllocations.organizationId, organizationId), inArray(customerCreditAllocations.creditNoteId, creditIds)));

  let excluded = 0;
  const sameCurrency = (c: string) => {
    if (c === currency) return true;
    excluded += 1;
    return false;
  };
  const invs = invoiceRows.filter((r) => sameCurrency(r.invoice.currency));
  const credits = creditRows.filter((r) => sameCurrency(r.credit.currency));
  const pays = paymentRows.filter((p) => sameCurrency(p.currency));

  // ---- Document events (the statement itself) ------------------------------------------------------------------
  const events: Event[] = [];
  let seq = 0;
  const zero = Money.zero(currency);
  for (const { invoice, voidDate } of invs) {
    events.push({
      date: iso(invoice.issueDate),
      seq: seq++,
      line: {
        date: iso(invoice.issueDate),
        type: "INVOICE",
        number: invoice.invoiceNumber,
        description: invoice.memo ?? `Invoice, due ${iso(invoice.dueDate)}`,
        charge: Money.of(invoice.total, currency).toString(),
        credit: zero.toString(),
        documentId: invoice.id,
      },
    });
    if (invoice.status === "VOID" && voidDate) {
      events.push({
        date: iso(voidDate),
        seq: seq++,
        line: {
          date: iso(voidDate),
          type: "INVOICE_VOID",
          number: invoice.invoiceNumber,
          description: `Void of invoice ${invoice.invoiceNumber}`,
          charge: zero.toString(),
          credit: Money.of(invoice.total, currency).toString(),
          documentId: invoice.id,
        },
      });
    }
  }
  for (const { credit, voidDate } of credits) {
    events.push({
      date: iso(credit.issueDate),
      seq: seq++,
      line: {
        date: iso(credit.issueDate),
        type: "CREDIT_NOTE",
        number: credit.creditNoteNumber,
        description: credit.memo ?? "Credit note",
        charge: zero.toString(),
        credit: Money.of(credit.total, currency).toString(),
        documentId: credit.id,
      },
    });
    if (credit.status === "VOID" && voidDate) {
      events.push({
        date: iso(voidDate),
        seq: seq++,
        line: {
          date: iso(voidDate),
          type: "CREDIT_NOTE_VOID",
          number: credit.creditNoteNumber,
          description: `Void of credit note ${credit.creditNoteNumber}`,
          charge: Money.of(credit.total, currency).toString(),
          credit: zero.toString(),
          documentId: credit.id,
        },
      });
    }
  }
  for (const payment of pays) {
    events.push({
      date: iso(payment.paymentDate),
      seq: seq++,
      line: {
        date: iso(payment.paymentDate),
        type: "PAYMENT",
        number: payment.reference ?? "Payment",
        description: `Payment received (${payment.method.toLowerCase().replace(/_/g, " ")})`,
        charge: zero.toString(),
        credit: Money.of(payment.amount, currency).toString(),
        documentId: payment.id,
      },
    });
  }
  const typeOrder: Record<StatementLineType, number> = { INVOICE: 0, CREDIT_NOTE_VOID: 1, PAYMENT: 2, CREDIT_NOTE: 3, INVOICE_VOID: 4 };
  events.sort((a, b) => a.date.localeCompare(b.date) || typeOrder[a.line.type] - typeOrder[b.line.type] || a.seq - b.seq);

  const fromKey = iso(from);
  const toKey = iso(to);
  let opening = zero;
  for (const e of events) {
    if (e.date < fromKey) opening = opening.add(Money.of(e.line.charge, currency)).subtract(Money.of(e.line.credit, currency));
  }
  let running = opening;
  let totalCharges = zero;
  let totalCredits = zero;
  const lines: StatementLine[] = [];
  for (const e of events) {
    if (e.date < fromKey || e.date > toKey) continue;
    const charge = Money.of(e.line.charge, currency);
    const credit = Money.of(e.line.credit, currency);
    running = running.add(charge).subtract(credit);
    totalCharges = totalCharges.add(charge);
    totalCredits = totalCredits.add(credit);
    lines.push({ ...e.line, balance: running.toString() });
  }
  const closing = running;

  // ---- Aged summary as at the end date, built from ALLOCATIONS (independent of the statement lines) ------------------
  const alive = (status: string, voidDate: Date | null) => !(status === "VOID" && voidDate && iso(voidDate) <= toKey);
  const paidOnInvoice = new Map<string, Money>();
  for (const a of payAllocs) {
    if (iso(new Date(a.effective)) > toKey) continue;
    paidOnInvoice.set(a.invoiceId, (paidOnInvoice.get(a.invoiceId) ?? zero).add(Money.of(a.amount, currency)));
  }
  for (const a of creditAllocs) {
    if (iso(a.appliedDate) > toKey) continue;
    paidOnInvoice.set(a.invoiceId, (paidOnInvoice.get(a.invoiceId) ?? zero).add(Money.of(a.amount, currency)));
  }

  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, zero])) as Record<AgingBucket, Money>;
  const openInvoices: StatementAgedInvoice[] = [];
  let openTotal = zero;
  for (const { invoice, voidDate } of invs) {
    if (iso(invoice.issueDate) > toKey || !alive(invoice.status, voidDate)) continue;
    const outstanding = Money.of(invoice.total, currency).subtract(paidOnInvoice.get(invoice.id) ?? zero);
    if (!outstanding.isPositive()) continue;
    const daysPastDue = daysBetween(to, invoice.dueDate);
    const bucket = bucketFor(daysPastDue);
    buckets[bucket] = buckets[bucket].add(outstanding);
    openTotal = openTotal.add(outstanding);
    openInvoices.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      dueDate: iso(invoice.dueDate),
      outstanding: outstanding.toString(),
      daysPastDue,
      bucket,
    });
  }
  openInvoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const unapplied: StatementUnappliedCredit[] = [];
  let unappliedTotal = zero;
  for (const { credit, voidDate } of credits) {
    if (iso(credit.issueDate) > toKey || !alive(credit.status, voidDate)) continue;
    const applied = creditAllocs
      .filter((a) => a.creditNoteId === credit.id && iso(a.appliedDate) <= toKey)
      .reduce((sum, a) => sum.add(Money.of(a.amount, currency)), zero);
    const remaining = Money.of(credit.total, currency).subtract(applied);
    if (!remaining.isPositive()) continue;
    unappliedTotal = unappliedTotal.add(remaining);
    unapplied.push({ kind: "CREDIT_NOTE", id: credit.id, label: credit.creditNoteNumber, date: iso(credit.issueDate), remaining: remaining.toString() });
  }
  for (const payment of pays) {
    if (iso(payment.paymentDate) > toKey) continue;
    const applied = payAllocs
      .filter((a) => a.paymentId === payment.id && iso(new Date(a.effective)) <= toKey)
      .reduce((sum, a) => sum.add(Money.of(a.amount, currency)), zero);
    const remaining = Money.of(payment.amount, currency).subtract(applied);
    if (!remaining.isPositive()) continue;
    unappliedTotal = unappliedTotal.add(remaining);
    unapplied.push({ kind: "PAYMENT", id: payment.id, label: payment.reference ?? "Payment received", date: iso(payment.paymentDate), remaining: remaining.toString() });
  }
  unapplied.sort((a, b) => a.date.localeCompare(b.date));

  const agedTotal = openTotal.subtract(unappliedTotal);
  const variance = closing.subtract(agedTotal);

  return {
    organizationName: org?.name ?? "",
    customer: { id: customer.id, name: customer.displayName, email: customer.email, taxNumber: customer.taxNumber },
    currency,
    from: fromKey,
    to: toKey,
    openingBalance: opening.toString(),
    lines,
    totalCharges: totalCharges.toString(),
    totalCredits: totalCredits.toString(),
    closingBalance: closing.toString(),
    aging: {
      asAt: toKey,
      buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, buckets[b].toString()])) as Record<AgingBucket, string>,
      openInvoices,
      openInvoicesTotal: openTotal.toString(),
      unappliedCredits: unapplied,
      unappliedCreditsTotal: unappliedTotal.toString(),
      total: agedTotal.toString(),
    },
    reconciliation: {
      closingBalance: closing.toString(),
      agedTotal: agedTotal.toString(),
      variance: variance.toString(),
      reconciled: variance.isZero(),
    },
    excludedForeignCurrencyDocuments: excluded,
  };
}

export const CustomerStatementService = {
  /**
   * A customer statement for a date range: opening balance, every invoice / credit note / payment (and void) in the
   * range with a running balance, the closing balance, and an aged summary as at the end date. Read-only; computed
   * fresh from stored documents and allocations. Reads need the invoice, payment and credit-note read permissions
   * because it shows all three.
   */
  async generate(actor: Actor, customerId: string, from: string, to: string, currency?: string): Promise<Statement> {
    assertPermission(actor, "customer_invoice:read");
    assertPermission(actor, "customer_payment:read");
    assertPermission(actor, "customer_credit:read");
    return withTenant(actor.organizationId, (tx) => loadStatement(tx, actor.organizationId, customerId, from, to, currency));
  },
};

export interface ArControlReconciliation {
  asAt: string;
  baseCurrency: string;
  subledger: { invoices: string; creditNotes: string; payments: string; total: string };
  ledger: { accounts: Array<{ code: string; name: string; balance: string }>; total: string };
  /** Ledger AR minus sub-ledger. Zero when every AR posting came from a sales document or payment. */
  variance: string;
  reconciled: boolean;
  /** Documents in a foreign currency are not in the sub-ledger total (the ledger holds their base amounts), so they can cause a variance. */
  foreignCurrencyDocuments: number;
}

export const ArControlReconciliationService = {
  /**
   * Compares the Accounts Receivable control account(s) in the ledger with the sub-ledger built from sales documents
   * (invoices - credit notes - payments), as at a date. The AR accounts are the ones sales documents actually posted
   * to. A manual journal straight to AR, or a foreign-currency document, shows up as a variance - it is reported,
   * never plugged.
   */
  async get(actor: Actor, asAtIso: string): Promise<ArControlReconciliation> {
    assertPermission(actor, "customer_invoice:read");
    assertPermission(actor, "customer_payment:read");
    assertPermission(actor, "customer_credit:read");
    const asAt = parseDay(asAtIso, "As-at date");
    return withTenant(actor.organizationId, async (tx) => {
      const orgId = actor.organizationId;
      const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, orgId));
      const base = org?.baseCurrency ?? "AUD";
      const voidJe = alias(journalEntries, "void_je");

      const sumOf = (rows: Array<{ total: string; currency: string; date: Date; voidDate?: Date | null; status?: string }>) => {
        let sum = Money.zero(base);
        let foreign = 0;
        for (const r of rows) {
          if (r.currency !== base) {
            foreign += 1;
            continue;
          }
          if (iso(r.date) > asAtIso) continue;
          sum = sum.add(Money.of(r.total, base));
          if (r.status === "VOID" && r.voidDate && iso(r.voidDate) <= asAtIso) sum = sum.subtract(Money.of(r.total, base));
        }
        return { sum, foreign };
      };

      const inv = await tx
        .select({ total: invoices.total, currency: invoices.currency, date: invoices.issueDate, status: invoices.status, voidDate: voidJe.postingDate, arAccountId: invoices.arAccountId })
        .from(invoices)
        .leftJoin(voidJe, eq(voidJe.id, invoices.voidJournalEntryId))
        .where(and(eq(invoices.organizationId, orgId), ne(invoices.status, "DRAFT")));
      const cn = await tx
        .select({ total: customerCreditNotes.total, currency: customerCreditNotes.currency, date: customerCreditNotes.issueDate, status: customerCreditNotes.status, voidDate: voidJe.postingDate, arAccountId: customerCreditNotes.arAccountId })
        .from(customerCreditNotes)
        .leftJoin(voidJe, eq(voidJe.id, customerCreditNotes.voidJournalEntryId))
        .where(and(eq(customerCreditNotes.organizationId, orgId), ne(customerCreditNotes.status, "DRAFT")));
      const pay = await tx
        .select({ total: payments.amount, currency: payments.currency, date: payments.paymentDate, journalEntryId: payments.journalEntryId })
        .from(payments)
        .where(eq(payments.organizationId, orgId));

      const i = sumOf(inv);
      const c = sumOf(cn);
      const p = sumOf(pay);
      const subledgerTotal = i.sum.subtract(c.sum).subtract(p.sum);

      // The AR accounts sales documents actually posted to: each invoice's and credit note's AR account, plus the
      // account(s) credited by a payment's own journal (the unallocated part of a payment goes to an AR account).
      const arIds = new Set<string>([...inv.map((x) => x.arAccountId), ...cn.map((x) => x.arAccountId)]);
      const paymentJournalIds = pay.map((x) => x.journalEntryId).filter((x): x is string => !!x);
      if (paymentJournalIds.length > 0) {
        const credited = await tx
          .select({ accountId: journalLines.accountId })
          .from(journalLines)
          .where(and(inArray(journalLines.journalEntryId, paymentJournalIds), sql`${journalLines.credit} > 0`));
        for (const row of credited) arIds.add(row.accountId);
      }

      const accountRows: Array<{ code: string; name: string; balance: string }> = [];
      let ledgerTotal = Money.zero(base);
      if (arIds.size > 0) {
        const sums = await tx
          .select({
            accountId: journalLines.accountId,
            code: accounts.code,
            name: accounts.name,
            balance: sql<string>`coalesce(sum(${journalLines.baseDebit} - ${journalLines.baseCredit}), 0)::text`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .where(
            and(
              eq(journalEntries.organizationId, orgId),
              ne(journalEntries.status, "DRAFT"),
              sql`${journalEntries.postingDate} < ${new Date(asAt.getTime() + 86_400_000).toISOString()}::timestamptz`,
              inArray(journalLines.accountId, [...arIds]),
            ),
          )
          .groupBy(journalLines.accountId, accounts.code, accounts.name);
        for (const s of sums.sort((a, b) => a.code.localeCompare(b.code))) {
          accountRows.push({ code: s.code, name: s.name, balance: Money.of(s.balance, base).toString() });
          ledgerTotal = ledgerTotal.add(Money.of(s.balance, base));
        }
      }

      const variance = ledgerTotal.subtract(subledgerTotal);
      return {
        asAt: asAtIso,
        baseCurrency: base,
        subledger: {
          invoices: i.sum.toString(),
          creditNotes: c.sum.toString(),
          payments: p.sum.toString(),
          total: subledgerTotal.toString(),
        },
        ledger: { accounts: accountRows, total: ledgerTotal.toString() },
        variance: variance.toString(),
        reconciled: variance.isZero(),
        foreignCurrencyDocuments: i.foreign + c.foreign + p.foreign,
      };
    });
  },
};
