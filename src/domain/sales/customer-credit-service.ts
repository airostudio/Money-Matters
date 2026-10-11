import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  accounts,
  contacts,
  customerCreditAllocations,
  customerCreditNoteLines,
  customerCreditNotes,
  invoices,
  products,
  taxCodes,
  type customerCreditStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService, type PostOptions } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  AllocationExceedsOutstandingError,
  CustomerCreditAllocationAlreadyReversedError,
  CustomerCreditAllocationExceedsAvailableError,
  CustomerCreditAllocationNotFoundError,
  CustomerCreditAlreadyVoidError,
  CustomerCreditCurrencyMismatchError,
  CustomerCreditCustomerMismatchError,
  CustomerCreditExceedsInvoiceError,
  CustomerCreditHasAllocationsError,
  CustomerCreditNotDraftError,
  CustomerCreditNotEditableError,
  CustomerCreditNotFoundError,
  CustomerCreditNotPostedError,
  CustomerCreditTrackedStockError,
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  InvoiceNotFoundError,
  InvoiceNotPostedForPaymentError,
  TaxCodeMissingPayableAccountError,
} from "./errors";
import { calculateInvoiceTotals } from "./invoice-calculations";
import { loadAllocatedTotal } from "./invoice-service";
import { loadCreditNoteAppliedTotal } from "./customer-credit-balance";
import { nextCustomerCreditNumber } from "./numbering";
import { refreshInvoiceStatus } from "./payment-service";
import type { CreateCustomerCreditInput, UpdateCustomerCreditInput } from "./types";

type CreditStatus = (typeof customerCreditStatusEnum.enumValues)[number];

const EDITABLE_STATUSES: CreditStatus[] = ["DRAFT"];
/** Posted and not void: the statuses in which a credit exists as an unapplied/partly-applied/applied credit. */
const LIVE_POSTED_STATUSES: CreditStatus[] = ["APPROVED", "PART_APPLIED", "APPLIED"];

async function assertActiveCustomer(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "CUSTOMER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForInvoiceError(contactId);
  }
  return contact;
}

async function assertAccountsUsable(tx: TenantDb, organizationId: string, accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return;
  const rows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, uniqueIds)));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of uniqueIds) {
    const row = found.get(id);
    if (!row) throw new InvalidInvoiceLineError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidInvoiceLineError(`Account ${id} is inactive.`);
  }
}

async function loadTaxCodes(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0) return new Map<string, { rate: string; payableAccountId: string | null; code: string }>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate, payableAccountId: taxCodes.payableAccountId, code: taxCodes.code })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, { rate: r.rate, payableAccountId: r.payableAccountId, code: r.code }]));
}

/**
 * A line that names a catalog product takes that product's revenue account. A TRACKED_INVENTORY product is REFUSED:
 * posting a credit would have to put the goods back into stock at their original weighted-average cost and reverse the
 * cost of goods sold, and the inventory ledger has no safe "sale return" movement yet (the same reason
 * `InvoiceService.voidInvoice` refuses a tracked-stock invoice). The user is told what to do instead.
 */
async function resolveProductLines(tx: TenantDb, organizationId: string, lines: CreateCustomerCreditInput["lines"]) {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))];
  if (productIds.length === 0) return lines;
  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.organizationId, organizationId), inArray(products.id, productIds)));
  const byId = new Map(rows.map((p) => [p.id, p]));
  return lines.map((line, index) => {
    if (!line.productId) return line;
    const product = byId.get(line.productId);
    if (!product) throw new InvalidInvoiceLineError(`Line ${index + 1}: unknown product.`);
    if (!product.isActive) throw new InvalidInvoiceLineError(`Line ${index + 1}: product ${product.sku} is inactive.`);
    if (product.type === "TRACKED_INVENTORY") throw new CustomerCreditTrackedStockError(product.sku);
    return { ...line, accountId: product.revenueAccountId };
  });
}

async function loadCreditOr404(tx: TenantDb, organizationId: string, creditId: string, lockForUpdate = false) {
  const query = tx
    .select()
    .from(customerCreditNotes)
    .where(and(eq(customerCreditNotes.id, creditId), eq(customerCreditNotes.organizationId, organizationId)));
  const [credit] = await (lockForUpdate ? query.for("update") : query);
  if (!credit) throw new CustomerCreditNotFoundError(creditId);
  return credit;
}

/** A linked invoice must be a posted invoice of the same customer in the same currency. */
async function assertLinkableInvoice(tx: TenantDb, organizationId: string, invoiceId: string, customerContactId: string, currency: string) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)));
  if (!invoice) throw new InvoiceNotFoundError(invoiceId);
  if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);
  if (invoice.customerContactId !== customerContactId) throw new CustomerCreditCustomerMismatchError("This credit note", invoice.invoiceNumber);
  if (invoice.currency !== currency) throw new CustomerCreditCurrencyMismatchError("This credit note", invoice.invoiceNumber);
  return invoice;
}

async function persistCreditWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateCustomerCreditInput,
  existingId?: string,
): Promise<{ id: string; creditNoteNumber: string }> {
  const customer = await assertActiveCustomer(tx, actor.organizationId, input.customerContactId);
  if (input.invoiceId) await assertLinkableInvoice(tx, actor.organizationId, input.invoiceId, input.customerContactId, input.currency);

  const resolvedLines = await resolveProductLines(tx, actor.organizationId, input.lines);
  await assertAccountsUsable(tx, actor.organizationId, [
    input.arAccountId,
    ...resolvedLines.map((l) => l.accountId).filter((id): id is string => !!id),
  ]);

  const taxCodeIds = resolvedLines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);
  const rateByCode = new Map([...taxCodesById.entries()].map(([id, v]) => [id, v.rate]));

  const totals = calculateInvoiceTotals(resolvedLines, input.currency, rateByCode);

  let creditId: string;
  let creditNoteNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(customerCreditNotes)
      .set({
        customerContactId: input.customerContactId,
        invoiceId: input.invoiceId ?? null,
        issueDate: input.issueDate,
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(customerCreditNotes.id, existingId))
      .returning({ id: customerCreditNotes.id, creditNoteNumber: customerCreditNotes.creditNoteNumber });
    if (!updated) throw new Error("Failed to update credit note.");
    creditId = updated.id;
    creditNoteNumber = updated.creditNoteNumber;
    await tx.delete(customerCreditNoteLines).where(eq(customerCreditNoteLines.creditNoteId, existingId));
  } else {
    creditNoteNumber = await nextCustomerCreditNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(customerCreditNotes)
      .values({
        organizationId: actor.organizationId,
        customerContactId: input.customerContactId,
        invoiceId: input.invoiceId ?? null,
        creditNoteNumber,
        issueDate: input.issueDate,
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: customerCreditNotes.id });
    if (!created) throw new Error("Failed to create credit note.");
    creditId = created.id;
  }

  await tx.insert(customerCreditNoteLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      creditNoteId: creditId,
      lineNumber: i + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      productId: line.productId,
      lineAmount: line.lineAmount,
      taxAmount: line.taxAmount,
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "customer_credit.updated" : "customer_credit.draft_created",
    entityType: "CustomerCreditNote",
    entityId: creditId,
    after: { creditNoteNumber, customer: customer.displayName, invoiceId: input.invoiceId ?? null, subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total },
  });

  return { id: creditId, creditNoteNumber };
}

/** Derives APPROVED / PART_APPLIED / APPLIED from the credit's net allocations and persists it when it changed. */
async function syncCreditStatus(tx: TenantDb, actor: Actor, creditId: string): Promise<CreditStatus> {
  const credit = await loadCreditOr404(tx, actor.organizationId, creditId);
  if (!LIVE_POSTED_STATUSES.includes(credit.status)) return credit.status;
  const applied = await loadCreditNoteAppliedTotal(tx, actor.organizationId, creditId, credit.currency);
  const total = Money.of(credit.total, credit.currency);
  const next: CreditStatus = applied.isZero() ? "APPROVED" : applied.compareTo(total) >= 0 ? "APPLIED" : "PART_APPLIED";
  if (next !== credit.status) {
    await tx
      .update(customerCreditNotes)
      .set({ status: next, updatedById: actor.userId, updatedAt: new Date() })
      .where(eq(customerCreditNotes.id, creditId));
  }
  return next;
}

export const CustomerCreditService = {
  async list(actor: Actor, opts: { status?: CreditStatus; customerContactId?: string; invoiceId?: string } = {}) {
    assertPermission(actor, "customer_credit:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(customerCreditNotes.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(customerCreditNotes.status, opts.status));
      if (opts.customerContactId) conditions.push(eq(customerCreditNotes.customerContactId, opts.customerContactId));
      if (opts.invoiceId) conditions.push(eq(customerCreditNotes.invoiceId, opts.invoiceId));

      const rows = await tx
        .select({ credit: customerCreditNotes, customer: contacts })
        .from(customerCreditNotes)
        .innerJoin(contacts, eq(contacts.id, customerCreditNotes.customerContactId))
        .where(and(...conditions))
        .orderBy(desc(customerCreditNotes.issueDate), desc(customerCreditNotes.creditNoteNumber));

      // One set-based allocation query for the whole page of credits, not one per row.
      const allocs =
        rows.length === 0
          ? []
          : await tx
              .select({ creditNoteId: customerCreditAllocations.creditNoteId, amount: customerCreditAllocations.amount })
              .from(customerCreditAllocations)
              .where(
                and(
                  eq(customerCreditAllocations.organizationId, actor.organizationId),
                  inArray(customerCreditAllocations.creditNoteId, rows.map((r) => r.credit.id)),
                ),
              );
      return rows.map((row) => {
        const applied = allocs
          .filter((a) => a.creditNoteId === row.credit.id)
          .reduce((sum, a) => sum.add(Money.of(a.amount, row.credit.currency)), Money.zero(row.credit.currency));
        return { ...row.credit, customer: row.customer, amountApplied: applied.toString() };
      });
    });
  },

  async get(actor: Actor, creditId: string) {
    assertPermission(actor, "customer_credit:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ credit: customerCreditNotes, customer: contacts })
        .from(customerCreditNotes)
        .innerJoin(contacts, eq(contacts.id, customerCreditNotes.customerContactId))
        .where(and(eq(customerCreditNotes.id, creditId), eq(customerCreditNotes.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: customerCreditNoteLines, account: accounts, taxCode: taxCodes })
        .from(customerCreditNoteLines)
        .innerJoin(accounts, eq(accounts.id, customerCreditNoteLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, customerCreditNoteLines.taxCodeId))
        .where(eq(customerCreditNoteLines.creditNoteId, creditId))
        .orderBy(asc(customerCreditNoteLines.lineNumber));

      const allocations = await tx
        .select({ allocation: customerCreditAllocations, invoiceNumber: invoices.invoiceNumber })
        .from(customerCreditAllocations)
        .innerJoin(invoices, eq(invoices.id, customerCreditAllocations.invoiceId))
        .where(and(eq(customerCreditAllocations.organizationId, actor.organizationId), eq(customerCreditAllocations.creditNoteId, creditId)))
        .orderBy(asc(customerCreditAllocations.createdAt));

      let linkedInvoice: { id: string; invoiceNumber: string } | null = null;
      if (row.credit.invoiceId) {
        const [inv] = await tx
          .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
          .from(invoices)
          .where(eq(invoices.id, row.credit.invoiceId));
        linkedInvoice = inv ?? null;
      }

      const amountApplied = await loadCreditNoteAppliedTotal(tx, actor.organizationId, creditId, row.credit.currency);
      const reversedIds = new Set(allocations.map((a) => a.allocation.reversesAllocationId).filter((id): id is string => !!id));

      return {
        ...row.credit,
        customer: row.customer,
        linkedInvoice,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
        allocations: allocations.map((a) => ({
          ...a.allocation,
          invoiceNumber: a.invoiceNumber,
          /** True for an application that can still be reversed (positive, not already reversed). */
          reversible: Money.of(a.allocation.amount, row.credit.currency).isPositive() && !reversedIds.has(a.allocation.id),
        })),
        amountApplied: amountApplied.toString(),
        amountRemaining: Money.of(row.credit.total, row.credit.currency).subtract(amountApplied).toString(),
      };
    });
  },

  async create(actor: Actor, input: CreateCustomerCreditInput) {
    assertPermission(actor, "customer_credit:manage");
    return withTenant(actor.organizationId, (tx) => persistCreditWithLines(tx, actor, input));
  },

  async update(actor: Actor, creditId: string, input: UpdateCustomerCreditInput) {
    assertPermission(actor, "customer_credit:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadCreditOr404(tx, actor.organizationId, creditId, true);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new CustomerCreditNotEditableError(existing.creditNoteNumber);
      return persistCreditWithLines(tx, actor, input, creditId);
    });
  },

  async deleteDraft(actor: Actor, creditId: string) {
    assertPermission(actor, "customer_credit:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadCreditOr404(tx, actor.organizationId, creditId, true);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new CustomerCreditNotEditableError(existing.creditNoteNumber);
      await tx.delete(customerCreditNotes).where(eq(customerCreditNotes.id, creditId));
      await AuditService.record(tx, actor, {
        action: "customer_credit.draft_deleted",
        entityType: "CustomerCreditNote",
        entityId: creditId,
        before: { creditNoteNumber: existing.creditNoteNumber },
      });
    });
  },

  /**
   * Approves and posts a draft credit note - the mirror image of `InvoiceService.approveAndPost`: debits each line's
   * revenue account and each tax code's payable (GST) account and credits the AR control account for the total, all
   * through `PostingService.postJournal` (so balance, period-lock and immutability are inherited, never re-implemented).
   * The GST debit is what reduces the BAS: the credit note's lines carry the same tax codes as an invoice, so BAS
   * collects them with a negative sign (see `collectDocumentLines`). Stock and COGS are NOT touched (tracked-stock
   * products are refused at draft time).
   */
  async approveAndPost(actor: Actor, creditId: string, postOptions?: PostOptions) {
    assertPermission(actor, "customer_credit:post");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId, true);
      if (credit.status !== "DRAFT") throw new CustomerCreditNotDraftError(credit.creditNoteNumber);

      const lines = await tx
        .select()
        .from(customerCreditNoteLines)
        .where(eq(customerCreditNoteLines.creditNoteId, creditId))
        .orderBy(asc(customerCreditNoteLines.lineNumber));
      if (lines.length === 0) throw new InvalidInvoiceLineError("A credit note needs at least one line before it can be posted.");

      const total = Money.of(credit.total, credit.currency);

      // A credit linked to an invoice, together with the other live credits linked to it, never exceeds the invoice.
      if (credit.invoiceId) {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, credit.invoiceId)).for("update");
        if (!invoice) throw new InvoiceNotFoundError(credit.invoiceId);
        if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);
        const others = await tx
          .select({ total: customerCreditNotes.total })
          .from(customerCreditNotes)
          .where(
            and(
              eq(customerCreditNotes.organizationId, actor.organizationId),
              eq(customerCreditNotes.invoiceId, credit.invoiceId),
              ne(customerCreditNotes.id, creditId),
              inArray(customerCreditNotes.status, LIVE_POSTED_STATUSES),
            ),
          );
        const already = others.reduce((sum, o) => sum.add(Money.of(o.total, credit.currency)), Money.zero(credit.currency));
        const room = Money.of(invoice.total, invoice.currency).subtract(already);
        if (total.compareTo(room) > 0) {
          throw new CustomerCreditExceedsInvoiceError(credit.creditNoteNumber, invoice.invoiceNumber, room.toString());
        }
      }

      const taxCodesById = await loadTaxCodes(
        tx,
        actor.organizationId,
        lines.map((l) => l.taxCodeId).filter((id): id is string => !!id),
      );

      const debitRevenueByAccount = new Map<string, Money>();
      for (const line of lines) {
        const running = debitRevenueByAccount.get(line.accountId) ?? Money.zero(credit.currency);
        debitRevenueByAccount.set(line.accountId, running.add(Money.of(line.lineAmount, credit.currency)));
      }

      const taxByAccount = new Map<string, Money>();
      for (const line of lines) {
        if (!line.taxCodeId) continue;
        const taxAmount = Money.of(line.taxAmount, credit.currency);
        if (taxAmount.isZero()) continue;
        const taxCode = taxCodesById.get(line.taxCodeId);
        if (!taxCode) throw new InvalidInvoiceLineError(`Unknown tax code on credit note line ${line.lineNumber}.`);
        if (!taxCode.payableAccountId) throw new TaxCodeMissingPayableAccountError(taxCode.code);
        const running = taxByAccount.get(taxCode.payableAccountId) ?? Money.zero(credit.currency);
        taxByAccount.set(taxCode.payableAccountId, running.add(taxAmount));
      }

      const journalLines: JournalLineDraft[] = [
        ...[...debitRevenueByAccount.entries()]
          .filter(([, amount]) => !amount.isZero())
          .map(([accountId, amount]) => ({
            accountId,
            debit: amount.toString(),
            currency: credit.currency,
            contactId: credit.customerContactId,
          })),
        ...[...taxByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: credit.currency,
        })),
        { accountId: credit.arAccountId, credit: total.toString(), currency: credit.currency, contactId: credit.customerContactId },
      ];

      const posted = await PostingService.postJournal(
        actor,
        {
          postingDate: credit.issueDate,
          memo: `Credit note ${credit.creditNoteNumber}`,
          sourceType: "MANUAL",
          lines: journalLines,
        },
        postOptions,
      );

      const [updated] = await tx
        .update(customerCreditNotes)
        .set({
          status: "APPROVED",
          journalEntryId: posted.entryId,
          postedAt: new Date(),
          postedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(customerCreditNotes.id, creditId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "customer_credit.posted",
        entityType: "CustomerCreditNote",
        entityId: creditId,
        before: { status: "DRAFT" },
        after: { status: "APPROVED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber, total: total.toString() },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /**
   * Voids a posted credit note by reversing its journal (never editing it). Refused while any of it is applied to an
   * invoice - un-apply first - so the fix is always "un-apply, then void".
   */
  async voidCredit(actor: Actor, creditId: string, reason: string) {
    assertPermission(actor, "customer_credit:void");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId, true);
      if (credit.status === "VOID") throw new CustomerCreditAlreadyVoidError(credit.creditNoteNumber);
      if (credit.status === "DRAFT" || !credit.journalEntryId) throw new CustomerCreditNotPostedError(credit.creditNoteNumber);

      const applied = await loadCreditNoteAppliedTotal(tx, actor.organizationId, creditId, credit.currency);
      if (!applied.isZero()) throw new CustomerCreditHasAllocationsError(credit.creditNoteNumber);

      const reversal = await PostingService.reverseEntry(actor, credit.journalEntryId, reason);

      const [updated] = await tx
        .update(customerCreditNotes)
        .set({
          status: "VOID",
          voidJournalEntryId: reversal.entryId,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(customerCreditNotes.id, creditId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "customer_credit.voided",
        entityType: "CustomerCreditNote",
        entityId: creditId,
        before: { status: credit.status },
        after: { status: "VOID", reversalEntryId: reversal.entryId, reason },
      });

      return updated;
    });
  },

  /**
   * Applies part or all of a posted credit note against an open invoice of the SAME customer (same currency). No
   * ledger posting: the credit note's own journal already credited Accounts Receivable once; applying it only changes
   * which invoice it settles (the sub-ledger), the same as `SupplierCreditService.applyToBill`. Enforces both caps:
   * never more than the credit's unapplied balance, never more than the invoice's outstanding balance. Append-only:
   * the application is a new row in `customer_credit_allocations`.
   */
  async applyToInvoice(actor: Actor, creditId: string, invoiceId: string, amount: string, appliedDate?: Date) {
    assertPermission(actor, "customer_credit:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId, true);
      if (!LIVE_POSTED_STATUSES.includes(credit.status)) throw new CustomerCreditNotPostedError(credit.creditNoteNumber);

      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, actor.organizationId)))
        .for("update");
      if (!invoice) throw new InvoiceNotFoundError(invoiceId);
      if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);
      if (invoice.customerContactId !== credit.customerContactId) {
        throw new CustomerCreditCustomerMismatchError(`Credit note ${credit.creditNoteNumber}`, invoice.invoiceNumber);
      }
      if (invoice.currency !== credit.currency) {
        throw new CustomerCreditCurrencyMismatchError(`Credit note ${credit.creditNoteNumber}`, invoice.invoiceNumber);
      }

      const applyAmount = Money.of(amount, credit.currency);
      if (!applyAmount.isPositive()) throw new InvalidInvoiceLineError("The amount to apply must be greater than zero.");

      const alreadyApplied = await loadCreditNoteAppliedTotal(tx, actor.organizationId, creditId, credit.currency);
      const available = Money.of(credit.total, credit.currency).subtract(alreadyApplied);
      if (applyAmount.compareTo(available) > 0) {
        throw new CustomerCreditAllocationExceedsAvailableError(`credit note ${credit.creditNoteNumber}`, available.toString(), applyAmount.toString());
      }

      const outstanding = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(await loadAllocatedTotal(tx, actor.organizationId, invoiceId), invoice.currency),
      );
      if (applyAmount.compareTo(outstanding) > 0) {
        throw new AllocationExceedsOutstandingError(invoice.invoiceNumber, outstanding.toString(), applyAmount.toString());
      }

      // Effective date: never before either document exists.
      const requested = appliedDate ?? new Date();
      const effective = new Date(Math.max(requested.getTime(), credit.issueDate.getTime(), invoice.issueDate.getTime()));

      await tx.insert(customerCreditAllocations).values({
        organizationId: actor.organizationId,
        creditNoteId: creditId,
        invoiceId,
        amount: applyAmount.toString(),
        appliedDate: effective,
        createdById: actor.userId,
      });

      await syncCreditStatus(tx, actor, creditId);
      await refreshInvoiceStatus(tx, actor, invoiceId);

      await AuditService.record(tx, actor, {
        action: "customer_credit.applied",
        entityType: "CustomerCreditNote",
        entityId: creditId,
        after: { invoiceId, invoiceNumber: invoice.invoiceNumber, amount: applyAmount.toString() },
      });

      return { creditNoteId: creditId, invoiceId, amount: applyAmount.toString() };
    });
  },

  /**
   * Reverses one earlier application by appending a NEGATIVE allocation (the original row is never touched). The
   * freed amount goes back to the credit note's unapplied balance and the invoice's outstanding balance, and both
   * statuses are recomputed. An application can be reversed once; a reversal row cannot itself be reversed.
   */
  async unapply(actor: Actor, allocationId: string, reason: string) {
    assertPermission(actor, "customer_credit:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [original] = await tx
        .select()
        .from(customerCreditAllocations)
        .where(and(eq(customerCreditAllocations.id, allocationId), eq(customerCreditAllocations.organizationId, actor.organizationId)));
      if (!original) throw new CustomerCreditAllocationNotFoundError(allocationId);

      const credit = await loadCreditOr404(tx, actor.organizationId, original.creditNoteId, true);
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, original.invoiceId)).for("update");
      if (!invoice) throw new InvoiceNotFoundError(original.invoiceId);

      if (Money.of(original.amount, credit.currency).isNegative()) throw new CustomerCreditAllocationAlreadyReversedError();
      const [existingReversal] = await tx
        .select({ id: customerCreditAllocations.id })
        .from(customerCreditAllocations)
        .where(eq(customerCreditAllocations.reversesAllocationId, allocationId));
      if (existingReversal) throw new CustomerCreditAllocationAlreadyReversedError();
      if (invoice.status === "VOID") throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);

      const effective = new Date(Math.max(Date.now(), original.appliedDate.getTime()));
      const negated = Money.of(original.amount, credit.currency).negate();

      await tx.insert(customerCreditAllocations).values({
        organizationId: actor.organizationId,
        creditNoteId: original.creditNoteId,
        invoiceId: original.invoiceId,
        amount: negated.toString(),
        appliedDate: effective,
        reversesAllocationId: allocationId,
        reason,
        createdById: actor.userId,
      });

      await syncCreditStatus(tx, actor, original.creditNoteId);
      await refreshInvoiceStatus(tx, actor, original.invoiceId);

      await AuditService.record(tx, actor, {
        action: "customer_credit.unapplied",
        entityType: "CustomerCreditNote",
        entityId: original.creditNoteId,
        after: { allocationId, invoiceId: original.invoiceId, amount: original.amount, reason },
      });

      return { creditNoteId: original.creditNoteId, invoiceId: original.invoiceId, amount: original.amount };
    });
  },
};
