import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  accounts,
  billLines,
  bills,
  contacts,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  paymentAllocations,
  payments,
  supplierPaymentAllocations,
  supplierPayments,
  type accountTypeEnum,
  type billStatusEnum,
  type contactKindEnum,
  type invoiceStatusEnum,
  type journalEntryStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { CursorPosition } from "./cursor";
import type { DocumentRow, DocumentLineRow, JournalRow, PaymentRow } from "./dto";

/**
 * The API's READ side: purpose-built, paginated, permission-checked queries.
 *
 * Why not just call the existing `*Service.list` methods? They return every row (unbounded) and some load per-row
 * totals in a loop - fine for a UI page, wrong for an API that must bound the work of a request. These queries
 * enforce the SAME permission a human needs for the same screen (`assertPermission` with the same permission the
 * service uses), run in exactly ONE `withTenant` transaction as the restricted `mm_app` role (row-level security
 * still applies; the explicit `organization_id` filter is defence in depth), use keyset pagination (stable under
 * concurrent inserts, no OFFSET scans), and return a handful of set-based queries - never one per row.
 *
 * Reports are NOT reimplemented: `ReportingService` / `LedgerService` are called as they are.
 */

export interface Page<T> {
  items: T[];
  /** Position of the last returned row when more rows follow, else null. */
  next: CursorPosition | null;
}

export interface PageParams {
  limit: number;
  after?: CursorPosition;
}

/** `created_at` as microsecond-exact UTC text, so the keyset comparison never loses precision to a JS Date. */
const createdAtText = (col: AnyPgColumn) => sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The "strictly after the cursor" predicate for (created_at DESC, id DESC) ordering. */
function keysetAfter(createdCol: AnyPgColumn, idCol: AnyPgColumn, after?: CursorPosition): SQL | undefined {
  if (!after) return undefined;
  return sql`(${createdCol}, ${idCol}) < (${after.t}::timestamptz, ${after.i}::uuid)`;
}

function finishPage<R extends { id: string; ck: string }>(rows: R[], limit: number): Page<R> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next: hasMore && last ? { t: last.ck, i: last.id } : null };
}

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function dayEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that is not even a UUID cannot exist; answer "not found" without sending it to Postgres. */
export const isUuid = (value: string) => UUID.test(value);

// ---- Contacts ---------------------------------------------------------------------------------------------------

type ContactKind = (typeof contactKindEnum.enumValues)[number];

export interface ContactFilters {
  /** Which kinds the endpoint serves: customers are CUSTOMER+BOTH, suppliers SUPPLIER+BOTH. */
  kinds: ContactKind[];
  includeInactive: boolean;
}

export async function listContacts(actor: Actor, filters: ContactFilters, page: PageParams) {
  assertPermission(actor, "contact:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(contacts.organizationId, actor.organizationId), inArray(contacts.kind, filters.kinds)];
    if (!filters.includeInactive) conditions.push(eq(contacts.isActive, true));
    const after = keysetAfter(contacts.createdAt, contacts.id, page.after);
    if (after) conditions.push(after);
    const rows = await tx
      .select({ contact: contacts, id: contacts.id, ck: createdAtText(contacts.createdAt) })
      .from(contacts)
      .where(and(...conditions))
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(page.limit + 1);
    return finishPage(rows, page.limit);
  });
}

export async function getContact(actor: Actor, id: string, kinds: ContactKind[]) {
  assertPermission(actor, "contact:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.organizationId, actor.organizationId), inArray(contacts.kind, kinds)));
    return row ?? null;
  });
}

// ---- Accounts ---------------------------------------------------------------------------------------------------

type AccountType = (typeof accountTypeEnum.enumValues)[number];

export async function listAccounts(actor: Actor, filters: { type?: AccountType; includeInactive: boolean }, page: PageParams) {
  assertPermission(actor, "account:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(accounts.organizationId, actor.organizationId)];
    if (!filters.includeInactive) conditions.push(eq(accounts.isActive, true));
    if (filters.type) conditions.push(eq(accounts.type, filters.type));
    const after = keysetAfter(accounts.createdAt, accounts.id, page.after);
    if (after) conditions.push(after);
    const rows = await tx
      .select({ account: accounts, id: accounts.id, ck: createdAtText(accounts.createdAt) })
      .from(accounts)
      .where(and(...conditions))
      .orderBy(desc(accounts.createdAt), desc(accounts.id))
      .limit(page.limit + 1);
    return finishPage(rows, page.limit);
  });
}

export async function getAccount(actor: Actor, id: string) {
  assertPermission(actor, "account:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.organizationId, actor.organizationId)));
    return row ?? null;
  });
}

// ---- Invoices ---------------------------------------------------------------------------------------------------

type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
type BillStatus = (typeof billStatusEnum.enumValues)[number];

export interface DocumentFilters<S> {
  status?: S;
  /** customer_id for invoices, supplier_id for bills. */
  counterpartyId?: string;
  issueDateFrom?: Date;
  issueDateTo?: Date;
}

async function allocatedByInvoice(tx: TenantDb, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: paymentAllocations.invoiceId, paid: sql<string>`sum(${paymentAllocations.amount})::text` })
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.organizationId, organizationId), inArray(paymentAllocations.invoiceId, ids)))
    .groupBy(paymentAllocations.invoiceId);
  return new Map(rows.map((r) => [r.id, r.paid]));
}

async function allocatedByBill(tx: TenantDb, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: supplierPaymentAllocations.billId, paid: sql<string>`sum(${supplierPaymentAllocations.amount})::text` })
    .from(supplierPaymentAllocations)
    .where(and(eq(supplierPaymentAllocations.organizationId, organizationId), inArray(supplierPaymentAllocations.billId, ids)))
    .groupBy(supplierPaymentAllocations.billId);
  return new Map(rows.map((r) => [r.id, r.paid]));
}

type InvoiceJoined = { invoice: typeof invoices.$inferSelect; customerName: string };
type BillJoined = { bill: typeof bills.$inferSelect; supplierName: string };

function invoiceRow(r: InvoiceJoined, paid: string | undefined, lines?: DocumentLineRow[]): DocumentRow {
  const i = r.invoice;
  return {
    id: i.id,
    number: i.invoiceNumber,
    status: i.status,
    counterpartyId: i.customerContactId,
    counterpartyName: r.customerName,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    currency: i.currency,
    memo: i.memo,
    reference: null,
    controlAccountId: i.arAccountId,
    subtotal: i.subtotal,
    taxTotal: i.taxTotal,
    total: i.total,
    amountPaid: paid ?? "0",
    postedAt: i.postedAt,
    createdAt: i.createdAt,
    lines,
  };
}

function billRow(r: BillJoined, paid: string | undefined, lines?: DocumentLineRow[]): DocumentRow {
  const b = r.bill;
  return {
    id: b.id,
    number: b.billNumber,
    status: b.status,
    counterpartyId: b.supplierContactId,
    counterpartyName: r.supplierName,
    issueDate: b.issueDate,
    dueDate: b.dueDate,
    currency: b.currency,
    memo: b.memo,
    reference: b.supplierReference,
    controlAccountId: b.apAccountId,
    subtotal: b.subtotal,
    taxTotal: b.taxTotal,
    total: b.total,
    amountPaid: paid ?? "0",
    postedAt: b.postedAt,
    createdAt: b.createdAt,
    lines,
  };
}

export async function listInvoices(actor: Actor, filters: DocumentFilters<InvoiceStatus>, page: PageParams) {
  assertPermission(actor, "customer_invoice:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(invoices.organizationId, actor.organizationId)];
    if (filters.status) conditions.push(eq(invoices.status, filters.status));
    if (filters.counterpartyId) conditions.push(eq(invoices.customerContactId, filters.counterpartyId));
    if (filters.issueDateFrom) conditions.push(gte(invoices.issueDate, dayStart(filters.issueDateFrom)));
    if (filters.issueDateTo) conditions.push(lte(invoices.issueDate, dayEnd(filters.issueDateTo)));
    const after = keysetAfter(invoices.createdAt, invoices.id, page.after);
    if (after) conditions.push(after);

    const rows = await tx
      .select({ invoice: invoices, customerName: contacts.displayName, id: invoices.id, ck: createdAtText(invoices.createdAt) })
      .from(invoices)
      .innerJoin(contacts, eq(contacts.id, invoices.customerContactId))
      .where(and(...conditions))
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(page.limit + 1);
    const paged = finishPage(rows, page.limit);
    const paid = await allocatedByInvoice(tx, actor.organizationId, paged.items.map((r) => r.id));
    return { items: paged.items.map((r) => invoiceRow(r, paid.get(r.id))), next: paged.next };
  });
}

export async function getInvoice(actor: Actor, id: string): Promise<DocumentRow | null> {
  assertPermission(actor, "customer_invoice:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, (tx) => loadInvoice(tx, actor.organizationId, id));
}

/** Loads one invoice with lines and amount paid - used by GET and to build the 201 body of a create (same shape, same transaction). */
export async function loadInvoice(tx: TenantDb, organizationId: string, id: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select({ invoice: invoices, customerName: contacts.displayName })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerContactId))
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, organizationId)));
  if (!row) return null;
  const lines = await tx
    .select()
    .from(invoiceLines)
    .where(and(eq(invoiceLines.invoiceId, id), eq(invoiceLines.organizationId, organizationId)))
    .orderBy(asc(invoiceLines.lineNumber));
  const paid = await allocatedByInvoice(tx, organizationId, [id]);
  return invoiceRow(row, paid.get(id), lines);
}

// ---- Bills ------------------------------------------------------------------------------------------------------

export async function listBills(actor: Actor, filters: DocumentFilters<BillStatus>, page: PageParams) {
  assertPermission(actor, "supplier_bill:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(bills.organizationId, actor.organizationId)];
    if (filters.status) conditions.push(eq(bills.status, filters.status));
    if (filters.counterpartyId) conditions.push(eq(bills.supplierContactId, filters.counterpartyId));
    if (filters.issueDateFrom) conditions.push(gte(bills.issueDate, dayStart(filters.issueDateFrom)));
    if (filters.issueDateTo) conditions.push(lte(bills.issueDate, dayEnd(filters.issueDateTo)));
    const after = keysetAfter(bills.createdAt, bills.id, page.after);
    if (after) conditions.push(after);

    const rows = await tx
      .select({ bill: bills, supplierName: contacts.displayName, id: bills.id, ck: createdAtText(bills.createdAt) })
      .from(bills)
      .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
      .where(and(...conditions))
      .orderBy(desc(bills.createdAt), desc(bills.id))
      .limit(page.limit + 1);
    const paged = finishPage(rows, page.limit);
    const paid = await allocatedByBill(tx, actor.organizationId, paged.items.map((r) => r.id));
    return { items: paged.items.map((r) => billRow(r, paid.get(r.id))), next: paged.next };
  });
}

export async function getBill(actor: Actor, id: string): Promise<DocumentRow | null> {
  assertPermission(actor, "supplier_bill:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, (tx) => loadBill(tx, actor.organizationId, id));
}

export async function loadBill(tx: TenantDb, organizationId: string, id: string): Promise<DocumentRow | null> {
  const [row] = await tx
    .select({ bill: bills, supplierName: contacts.displayName })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
    .where(and(eq(bills.id, id), eq(bills.organizationId, organizationId)));
  if (!row) return null;
  const lines = await tx
    .select()
    .from(billLines)
    .where(and(eq(billLines.billId, id), eq(billLines.organizationId, organizationId)))
    .orderBy(asc(billLines.lineNumber));
  const paid = await allocatedByBill(tx, organizationId, [id]);
  return billRow(row, paid.get(id), lines);
}

// ---- Payments (customer receipts and supplier payments) ----------------------------------------------------------

export interface PaymentFilters {
  counterpartyId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listPayments(actor: Actor, filters: PaymentFilters, page: PageParams) {
  assertPermission(actor, "customer_payment:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(payments.organizationId, actor.organizationId)];
    if (filters.counterpartyId) conditions.push(eq(payments.customerContactId, filters.counterpartyId));
    if (filters.dateFrom) conditions.push(gte(payments.paymentDate, dayStart(filters.dateFrom)));
    if (filters.dateTo) conditions.push(lte(payments.paymentDate, dayEnd(filters.dateTo)));
    const after = keysetAfter(payments.createdAt, payments.id, page.after);
    if (after) conditions.push(after);
    const rows = await tx
      .select({ payment: payments, name: contacts.displayName, id: payments.id, ck: createdAtText(payments.createdAt) })
      .from(payments)
      .innerJoin(contacts, eq(contacts.id, payments.customerContactId))
      .where(and(...conditions))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(page.limit + 1);
    const paged = finishPage(rows, page.limit);
    return {
      items: paged.items.map(
        (r): PaymentRow => ({
          id: r.id,
          counterpartyId: r.payment.customerContactId,
          counterpartyName: r.name,
          paymentDate: r.payment.paymentDate,
          amount: r.payment.amount,
          currency: r.payment.currency,
          method: r.payment.method,
          reference: r.payment.reference,
          createdAt: r.payment.createdAt,
        }),
      ),
      next: paged.next,
    };
  });
}

export async function getPayment(actor: Actor, id: string): Promise<PaymentRow | null> {
  assertPermission(actor, "customer_payment:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, async (tx) => {
    const [r] = await tx
      .select({ payment: payments, name: contacts.displayName })
      .from(payments)
      .innerJoin(contacts, eq(contacts.id, payments.customerContactId))
      .where(and(eq(payments.id, id), eq(payments.organizationId, actor.organizationId)));
    if (!r) return null;
    const allocations = await tx
      .select({ documentId: invoices.id, documentNumber: invoices.invoiceNumber, amount: paymentAllocations.amount })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .where(and(eq(paymentAllocations.paymentId, id), eq(paymentAllocations.organizationId, actor.organizationId)));
    return {
      id: r.payment.id,
      counterpartyId: r.payment.customerContactId,
      counterpartyName: r.name,
      paymentDate: r.payment.paymentDate,
      amount: r.payment.amount,
      currency: r.payment.currency,
      method: r.payment.method,
      reference: r.payment.reference,
      createdAt: r.payment.createdAt,
      allocations,
    };
  });
}

export async function listSupplierPayments(actor: Actor, filters: PaymentFilters, page: PageParams) {
  assertPermission(actor, "supplier_payment:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(supplierPayments.organizationId, actor.organizationId)];
    if (filters.counterpartyId) conditions.push(eq(supplierPayments.supplierContactId, filters.counterpartyId));
    if (filters.dateFrom) conditions.push(gte(supplierPayments.paymentDate, dayStart(filters.dateFrom)));
    if (filters.dateTo) conditions.push(lte(supplierPayments.paymentDate, dayEnd(filters.dateTo)));
    const after = keysetAfter(supplierPayments.createdAt, supplierPayments.id, page.after);
    if (after) conditions.push(after);
    const rows = await tx
      .select({ payment: supplierPayments, name: contacts.displayName, id: supplierPayments.id, ck: createdAtText(supplierPayments.createdAt) })
      .from(supplierPayments)
      .innerJoin(contacts, eq(contacts.id, supplierPayments.supplierContactId))
      .where(and(...conditions))
      .orderBy(desc(supplierPayments.createdAt), desc(supplierPayments.id))
      .limit(page.limit + 1);
    const paged = finishPage(rows, page.limit);
    return {
      items: paged.items.map(
        (r): PaymentRow => ({
          id: r.id,
          counterpartyId: r.payment.supplierContactId,
          counterpartyName: r.name,
          paymentDate: r.payment.paymentDate,
          amount: r.payment.amount,
          currency: r.payment.currency,
          method: r.payment.method,
          reference: r.payment.reference,
          createdAt: r.payment.createdAt,
        }),
      ),
      next: paged.next,
    };
  });
}

export async function getSupplierPayment(actor: Actor, id: string): Promise<PaymentRow | null> {
  assertPermission(actor, "supplier_payment:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, async (tx) => {
    const [r] = await tx
      .select({ payment: supplierPayments, name: contacts.displayName })
      .from(supplierPayments)
      .innerJoin(contacts, eq(contacts.id, supplierPayments.supplierContactId))
      .where(and(eq(supplierPayments.id, id), eq(supplierPayments.organizationId, actor.organizationId)));
    if (!r) return null;
    const allocations = await tx
      .select({ documentId: bills.id, documentNumber: bills.billNumber, amount: supplierPaymentAllocations.amount })
      .from(supplierPaymentAllocations)
      .innerJoin(bills, eq(bills.id, supplierPaymentAllocations.billId))
      .where(and(eq(supplierPaymentAllocations.paymentId, id), eq(supplierPaymentAllocations.organizationId, actor.organizationId)));
    return {
      id: r.payment.id,
      counterpartyId: r.payment.supplierContactId,
      counterpartyName: r.name,
      paymentDate: r.payment.paymentDate,
      amount: r.payment.amount,
      currency: r.payment.currency,
      method: r.payment.method,
      reference: r.payment.reference,
      createdAt: r.payment.createdAt,
      allocations,
    };
  });
}

// ---- Journals ---------------------------------------------------------------------------------------------------

type JournalStatus = (typeof journalEntryStatusEnum.enumValues)[number];

export async function listJournals(
  actor: Actor,
  filters: { status?: JournalStatus; dateFrom?: Date; dateTo?: Date },
  page: PageParams,
) {
  assertPermission(actor, "journal:read");
  return withTenant(actor.organizationId, async (tx) => {
    const conditions = [eq(journalEntries.organizationId, actor.organizationId)];
    if (filters.status) conditions.push(eq(journalEntries.status, filters.status));
    if (filters.dateFrom) conditions.push(gte(journalEntries.postingDate, dayStart(filters.dateFrom)));
    if (filters.dateTo) conditions.push(lte(journalEntries.postingDate, dayEnd(filters.dateTo)));
    const after = keysetAfter(journalEntries.createdAt, journalEntries.id, page.after);
    if (after) conditions.push(after);
    const rows = await tx
      .select({ entry: journalEntries, id: journalEntries.id, ck: createdAtText(journalEntries.createdAt) })
      .from(journalEntries)
      .where(and(...conditions))
      .orderBy(desc(journalEntries.createdAt), desc(journalEntries.id))
      .limit(page.limit + 1);
    const paged = finishPage(rows, page.limit);
    const baseCurrency = await orgBaseCurrency(tx, actor.organizationId);
    return { items: paged.items.map((r) => journalRow(r.entry, baseCurrency)), next: paged.next };
  });
}

export async function getJournal(actor: Actor, id: string): Promise<JournalRow | null> {
  assertPermission(actor, "journal:read");
  if (!isUuid(id)) return null;
  return withTenant(actor.organizationId, async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.organizationId, actor.organizationId)));
    if (!entry) return null;
    const lines = await tx
      .select({ line: journalLines, code: accounts.code, name: accounts.name })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(eq(journalLines.journalEntryId, id), eq(journalLines.organizationId, actor.organizationId)))
      .orderBy(asc(journalLines.lineNumber));
    const baseCurrency = await orgBaseCurrency(tx, actor.organizationId);
    return {
      ...journalRow(entry, baseCurrency),
      lines: lines.map((l) => ({
        lineNumber: l.line.lineNumber,
        accountId: l.line.accountId,
        accountCode: l.code,
        accountName: l.name,
        memo: l.line.memo,
        currency: l.line.currency,
        exchangeRate: l.line.exchangeRate,
        debit: l.line.debit,
        credit: l.line.credit,
        baseDebit: l.line.baseDebit,
        baseCredit: l.line.baseCredit,
      })),
    };
  });
}

async function orgBaseCurrency(tx: TenantDb, organizationId: string): Promise<string> {
  const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.baseCurrency ?? "AUD";
}

function journalRow(entry: typeof journalEntries.$inferSelect, baseCurrency: string): JournalRow {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    postingDate: entry.postingDate,
    memo: entry.memo,
    status: entry.status,
    sourceType: entry.sourceType,
    postedAt: entry.postedAt,
    createdAt: entry.createdAt,
    baseCurrency,
  };
}

export { dayStart, dayEnd };
