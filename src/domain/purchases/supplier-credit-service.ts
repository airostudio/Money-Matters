import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  bills,
  contacts,
  supplierCreditAllocations,
  supplierCreditNoteLines,
  supplierCreditNotes,
  taxCodes,
  type supplierCreditStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  BillNotFoundError,
  BillNotPostedForPaymentError,
  InvalidBillLineError,
  InvalidContactForBillError,
  SupplierAllocationExceedsOutstandingError,
  SupplierCreditAllocationExceedsAvailableError,
  SupplierCreditAlreadyVoidError,
  SupplierCreditCurrencyMismatchError,
  SupplierCreditHasAllocationsError,
  SupplierCreditNotDraftError,
  SupplierCreditNotEditableError,
  SupplierCreditNotFoundError,
  SupplierCreditNotPostedError,
  TaxCodeMissingReceivableAccountError,
} from "./errors";
import { calculateBillTotals } from "./bill-calculations";
import { nextSupplierCreditNumber } from "./numbering";
import { loadAllocatedTotal } from "./bill-service";
import type { CreateSupplierCreditInput, UpdateSupplierCreditInput } from "./types";

type CreditStatus = (typeof supplierCreditStatusEnum.enumValues)[number];

const EDITABLE_STATUSES: CreditStatus[] = ["DRAFT"];
const APPLIED_LIKE_STATUSES = new Set<CreditStatus>(["APPROVED", "PART_APPLIED"]);

async function assertActiveSupplier(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "SUPPLIER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForBillError(contactId);
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
    if (!row) throw new InvalidBillLineError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidBillLineError(`Account ${id} is inactive.`);
  }
}

async function loadTaxCodes(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0)
    return new Map<string, { rate: string; receivableAccountId: string | null; code: string }>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate, receivableAccountId: taxCodes.receivableAccountId, code: taxCodes.code })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, { rate: r.rate, receivableAccountId: r.receivableAccountId, code: r.code }]));
}

async function loadCreditOr404(tx: TenantDb, organizationId: string, creditId: string) {
  const [credit] = await tx
    .select()
    .from(supplierCreditNotes)
    .where(and(eq(supplierCreditNotes.id, creditId), eq(supplierCreditNotes.organizationId, organizationId)));
  if (!credit) throw new SupplierCreditNotFoundError(creditId);
  return credit;
}

/** Sum of everything ever applied against this credit note. */
async function loadAppliedTotal(tx: TenantDb, organizationId: string, creditId: string): Promise<string> {
  const rows = await tx
    .select({ amount: supplierCreditAllocations.amount })
    .from(supplierCreditAllocations)
    .where(and(eq(supplierCreditAllocations.organizationId, organizationId), eq(supplierCreditAllocations.creditNoteId, creditId)));
  const [credit] = await tx.select({ currency: supplierCreditNotes.currency }).from(supplierCreditNotes).where(eq(supplierCreditNotes.id, creditId));
  const currency = credit?.currency ?? "AUD";
  return rows.reduce((sum, r) => sum.add(Money.of(r.amount, currency)), Money.zero(currency)).toString();
}

async function persistCreditWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateSupplierCreditInput,
  existingId?: string,
): Promise<{ id: string; creditNoteNumber: string }> {
  const supplier = await assertActiveSupplier(tx, actor.organizationId, input.supplierContactId);
  await assertAccountsUsable(tx, actor.organizationId, [input.apAccountId, ...input.lines.map((l) => l.accountId)]);

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);
  const rateByCode = new Map([...taxCodesById.entries()].map(([id, v]) => [id, v.rate]));

  const totals = calculateBillTotals(input.lines, input.currency, rateByCode);

  let creditId: string;
  let creditNoteNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(supplierCreditNotes)
      .set({
        supplierContactId: input.supplierContactId,
        issueDate: input.issueDate,
        currency: input.currency,
        apAccountId: input.apAccountId,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(supplierCreditNotes.id, existingId))
      .returning({ id: supplierCreditNotes.id, creditNoteNumber: supplierCreditNotes.creditNoteNumber });
    if (!updated) throw new Error("Failed to update credit note.");
    creditId = updated.id;
    creditNoteNumber = updated.creditNoteNumber;
    await tx.delete(supplierCreditNoteLines).where(eq(supplierCreditNoteLines.creditNoteId, existingId));
  } else {
    creditNoteNumber = await nextSupplierCreditNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(supplierCreditNotes)
      .values({
        organizationId: actor.organizationId,
        supplierContactId: input.supplierContactId,
        creditNoteNumber,
        issueDate: input.issueDate,
        currency: input.currency,
        apAccountId: input.apAccountId,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: supplierCreditNotes.id });
    if (!created) throw new Error("Failed to create credit note.");
    creditId = created.id;
  }

  await tx.insert(supplierCreditNoteLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      creditNoteId: creditId,
      lineNumber: i + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      lineAmount: line.lineAmount,
      taxAmount: line.taxAmount,
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "supplier_credit.updated" : "supplier_credit.draft_created",
    entityType: "SupplierCreditNote",
    entityId: creditId,
    after: { creditNoteNumber, supplier: supplier.displayName, ...totals },
  });

  return { id: creditId, creditNoteNumber };
}

export const SupplierCreditService = {
  async list(actor: Actor, opts: { status?: CreditStatus; supplierContactId?: string } = {}) {
    assertPermission(actor, "supplier_credit:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(supplierCreditNotes.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(supplierCreditNotes.status, opts.status));
      if (opts.supplierContactId) conditions.push(eq(supplierCreditNotes.supplierContactId, opts.supplierContactId));

      const rows = await tx
        .select({ credit: supplierCreditNotes, supplier: contacts })
        .from(supplierCreditNotes)
        .innerJoin(contacts, eq(contacts.id, supplierCreditNotes.supplierContactId))
        .where(and(...conditions))
        .orderBy(desc(supplierCreditNotes.issueDate), desc(supplierCreditNotes.creditNoteNumber));

      return Promise.all(
        rows.map(async (row) => {
          const applied = await loadAppliedTotal(tx, actor.organizationId, row.credit.id);
          return { ...row.credit, supplier: row.supplier, amountApplied: applied };
        }),
      );
    });
  },

  async get(actor: Actor, creditId: string) {
    assertPermission(actor, "supplier_credit:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ credit: supplierCreditNotes, supplier: contacts })
        .from(supplierCreditNotes)
        .innerJoin(contacts, eq(contacts.id, supplierCreditNotes.supplierContactId))
        .where(and(eq(supplierCreditNotes.id, creditId), eq(supplierCreditNotes.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: supplierCreditNoteLines, account: accounts, taxCode: taxCodes })
        .from(supplierCreditNoteLines)
        .innerJoin(accounts, eq(accounts.id, supplierCreditNoteLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, supplierCreditNoteLines.taxCodeId))
        .where(eq(supplierCreditNoteLines.creditNoteId, creditId))
        .orderBy(asc(supplierCreditNoteLines.lineNumber));

      const allocations = await tx
        .select({ allocation: supplierCreditAllocations, bill: bills })
        .from(supplierCreditAllocations)
        .innerJoin(bills, eq(bills.id, supplierCreditAllocations.billId))
        .where(and(eq(supplierCreditAllocations.organizationId, actor.organizationId), eq(supplierCreditAllocations.creditNoteId, creditId)));

      const amountApplied = await loadAppliedTotal(tx, actor.organizationId, creditId);

      return {
        ...row.credit,
        supplier: row.supplier,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
        allocations,
        amountApplied,
      };
    });
  },

  async create(actor: Actor, input: CreateSupplierCreditInput) {
    assertPermission(actor, "supplier_credit:manage");
    return withTenant(actor.organizationId, (tx) => persistCreditWithLines(tx, actor, input));
  },

  async update(actor: Actor, creditId: string, input: UpdateSupplierCreditInput) {
    assertPermission(actor, "supplier_credit:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadCreditOr404(tx, actor.organizationId, creditId);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new SupplierCreditNotEditableError(existing.creditNoteNumber);
      return persistCreditWithLines(tx, actor, input, creditId);
    });
  },

  async deleteDraft(actor: Actor, creditId: string) {
    assertPermission(actor, "supplier_credit:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadCreditOr404(tx, actor.organizationId, creditId);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new SupplierCreditNotEditableError(existing.creditNoteNumber);
      await tx.delete(supplierCreditNotes).where(eq(supplierCreditNotes.id, creditId));
      await AuditService.record(tx, actor, {
        action: "supplier_credit.draft_deleted",
        entityType: "SupplierCreditNote",
        entityId: creditId,
        before: { creditNoteNumber: existing.creditNoteNumber },
      });
    });
  },

  /**
   * Approves and posts a draft credit note: the mirror image of
   * `BillService.approveAndPost` — credits each line's expense/asset account
   * (and each tax code's input-credit account) and debits Accounts Payable,
   * via `PostingService.postJournal`, never a direct `journal_lines` write.
   */
  async approveAndPost(actor: Actor, creditId: string) {
    assertPermission(actor, "supplier_credit:post");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId);
      if (credit.status !== "DRAFT") throw new SupplierCreditNotDraftError(credit.creditNoteNumber);

      const lines = await tx
        .select()
        .from(supplierCreditNoteLines)
        .where(eq(supplierCreditNoteLines.creditNoteId, creditId))
        .orderBy(asc(supplierCreditNoteLines.lineNumber));
      if (lines.length === 0) throw new InvalidBillLineError("A credit note needs at least one line before it can be posted.");

      const taxCodeIds = lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
      const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);

      const creditByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        const running = creditByAccount.get(line.accountId) ?? Money.zero(credit.currency);
        creditByAccount.set(line.accountId, running.add(Money.of(line.lineAmount, credit.currency)));
      }

      const taxByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        if (!line.taxCodeId) continue;
        const taxAmount = Money.of(line.taxAmount, credit.currency);
        if (taxAmount.isZero()) continue;
        const taxCode = taxCodesById.get(line.taxCodeId);
        if (!taxCode) throw new InvalidBillLineError(`Unknown tax code on credit note line ${line.lineNumber}.`);
        if (!taxCode.receivableAccountId) throw new TaxCodeMissingReceivableAccountError(taxCode.code);
        const running = taxByAccount.get(taxCode.receivableAccountId) ?? Money.zero(credit.currency);
        taxByAccount.set(taxCode.receivableAccountId, running.add(taxAmount));
      }

      const total = Money.of(credit.total, credit.currency);

      const journalLines: JournalLineDraft[] = [
        { accountId: credit.apAccountId, debit: total.toString(), currency: credit.currency, contactId: credit.supplierContactId },
        ...[...creditByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          credit: amount.toString(),
          currency: credit.currency,
          contactId: credit.supplierContactId,
        })),
        ...[...taxByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          credit: amount.toString(),
          currency: credit.currency,
        })),
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: credit.issueDate,
        memo: `Supplier credit ${credit.creditNoteNumber}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      const [updated] = await tx
        .update(supplierCreditNotes)
        .set({
          status: "APPROVED",
          journalEntryId: posted.entryId,
          postedAt: new Date(),
          postedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(supplierCreditNotes.id, creditId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "supplier_credit.posted",
        entityType: "SupplierCreditNote",
        entityId: creditId,
        before: { status: "DRAFT" },
        after: { status: "APPROVED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  async voidCredit(actor: Actor, creditId: string, reason: string) {
    assertPermission(actor, "supplier_credit:void");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId);
      if (credit.status === "VOID") throw new SupplierCreditAlreadyVoidError(credit.creditNoteNumber);
      if (credit.status === "DRAFT" || !credit.journalEntryId) throw new SupplierCreditNotPostedError(credit.creditNoteNumber);

      const applied = await loadAppliedTotal(tx, actor.organizationId, creditId);
      if (!Money.of(applied, credit.currency).isZero()) throw new SupplierCreditHasAllocationsError(credit.creditNoteNumber);

      const reversal = await PostingService.reverseEntry(actor, credit.journalEntryId, reason);

      const [updated] = await tx
        .update(supplierCreditNotes)
        .set({
          status: "VOID",
          voidJournalEntryId: reversal.entryId,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(supplierCreditNotes.id, creditId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "supplier_credit.voided",
        entityType: "SupplierCreditNote",
        entityId: creditId,
        before: { status: credit.status },
        after: { status: "VOID", reversalEntryId: reversal.entryId, reason },
      });

      return updated;
    });
  },

  /**
   * Applies part or all of a posted credit note against an outstanding
   * bill — the mirror of `SupplierPaymentAllocationService.recordPayment`'s
   * allocation, but the credit reduces what's owed directly rather than
   * through a payment; no ledger posting happens here (the credit note's own
   * `approveAndPost` already posted the accounting effect once). Enforces
   * the same pair of invariants: the allocation never exceeds the credit
   * note's own remaining balance, nor the bill's outstanding balance.
   */
  async applyToBill(actor: Actor, creditId: string, billId: string, amount: string) {
    assertPermission(actor, "supplier_credit:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const credit = await loadCreditOr404(tx, actor.organizationId, creditId);
      if (!APPLIED_LIKE_STATUSES.has(credit.status)) throw new SupplierCreditNotPostedError(credit.creditNoteNumber);

      const [bill] = await tx.select().from(bills).where(and(eq(bills.id, billId), eq(bills.organizationId, actor.organizationId)));
      if (!bill) throw new BillNotFoundError(billId);
      if (bill.status === "DRAFT" || bill.status === "VOID") throw new BillNotPostedForPaymentError(bill.billNumber);
      if (bill.currency !== credit.currency) throw new SupplierCreditCurrencyMismatchError(credit.creditNoteNumber);

      const applyAmount = Money.of(amount, credit.currency);
      if (!applyAmount.isPositive()) throw new InvalidBillLineError("The amount to apply must be greater than zero.");

      const alreadyApplied = Money.of(await loadAppliedTotal(tx, actor.organizationId, creditId), credit.currency);
      const creditTotal = Money.of(credit.total, credit.currency);
      const creditAvailable = creditTotal.subtract(alreadyApplied);
      if (applyAmount.compareTo(creditAvailable) > 0) {
        throw new SupplierCreditAllocationExceedsAvailableError(credit.creditNoteNumber, creditAvailable.toString(), applyAmount.toString());
      }

      const billAllocated = Money.of(await loadAllocatedTotal(tx, actor.organizationId, billId), bill.currency);
      const billOutstanding = Money.of(bill.total, bill.currency).subtract(billAllocated);
      if (applyAmount.compareTo(billOutstanding) > 0) {
        throw new SupplierAllocationExceedsOutstandingError(bill.billNumber, billOutstanding.toString(), applyAmount.toString());
      }

      await tx.insert(supplierCreditAllocations).values({
        organizationId: actor.organizationId,
        creditNoteId: creditId,
        billId,
        amount: applyAmount.toString(),
        createdById: actor.userId,
      });

      const nowApplied = alreadyApplied.add(applyAmount);
      const nextCreditStatus: CreditStatus = nowApplied.compareTo(creditTotal) >= 0 ? "APPLIED" : "PART_APPLIED";
      if (nextCreditStatus !== credit.status) {
        await tx.update(supplierCreditNotes).set({ status: nextCreditStatus, updatedById: actor.userId, updatedAt: new Date() }).where(eq(supplierCreditNotes.id, creditId));
      }

      // The bill's own PART_PAID/PAID status is driven by the *combined*
      // total of cash allocations plus credit allocations — `loadAllocatedTotal`
      // sums `supplier_payment_allocations` only, so recompute the bill's
      // status here from both sources together.
      const totalOffsetAgainstBill = billAllocated.add(applyAmount);
      const billTotal = Money.of(bill.total, bill.currency);
      const nextBillStatus = totalOffsetAgainstBill.compareTo(billTotal) >= 0 ? "PAID" : "PART_PAID";
      if (nextBillStatus !== bill.status) {
        await tx.update(bills).set({ status: nextBillStatus, updatedById: actor.userId, updatedAt: new Date() }).where(eq(bills.id, billId));
      }

      await AuditService.record(tx, actor, {
        action: "supplier_credit.applied",
        entityType: "SupplierCreditNote",
        entityId: creditId,
        after: { billId, billNumber: bill.billNumber, amount: applyAmount.toString() },
      });

      return { creditNoteId: creditId, billId, amount: applyAmount.toString() };
    });
  },
};
