import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  billLines,
  bills,
  contacts,
  taxCodes,
  type billStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  BillAlreadyVoidError,
  BillHasPaymentsError,
  BillNotDraftError,
  BillNotEditableError,
  BillNotFoundError,
  BillNotPostedError,
  InvalidBillLineError,
  InvalidContactForBillError,
  TaxCodeMissingReceivableAccountError,
} from "./errors";
import { calculateBillTotals } from "./bill-calculations";
import { nextBillNumber } from "./numbering";
import type { CreateBillInput, UpdateBillInput } from "./types";
import { supplierPaymentAllocations } from "@/db/schema";

type BillStatus = (typeof billStatusEnum.enumValues)[number];

/** Statuses in which a bill's header/lines may still be edited or the draft deleted. */
const EDITABLE_STATUSES: BillStatus[] = ["DRAFT"];

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

/** Loads {rate, receivableAccountId} for a set of tax code ids, scoped to the org. */
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

async function loadBillOr404(tx: TenantDb, organizationId: string, billId: string) {
  const [bill] = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.organizationId, organizationId)));
  if (!bill) throw new BillNotFoundError(billId);
  return bill;
}

/** Sum of everything ever allocated against this bill — the source of truth for "outstanding", never a denormalized counter. */
export async function loadAllocatedTotal(tx: TenantDb, organizationId: string, billId: string): Promise<string> {
  const rows = await tx
    .select({ amount: supplierPaymentAllocations.amount })
    .from(supplierPaymentAllocations)
    .where(and(eq(supplierPaymentAllocations.organizationId, organizationId), eq(supplierPaymentAllocations.billId, billId)));
  const [bill] = await tx.select({ currency: bills.currency }).from(bills).where(eq(bills.id, billId));
  const currency = bill?.currency ?? "AUD";
  return rows.reduce((sum, r) => sum.add(Money.of(r.amount, currency)), Money.zero(currency)).toString();
}

async function persistBillWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateBillInput,
  existingId?: string,
): Promise<{ id: string; billNumber: string }> {
  const supplier = await assertActiveSupplier(tx, actor.organizationId, input.supplierContactId);
  await assertAccountsUsable(tx, actor.organizationId, [
    input.apAccountId,
    ...input.lines.map((l) => l.accountId),
  ]);

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);
  const rateByCode = new Map([...taxCodesById.entries()].map(([id, v]) => [id, v.rate]));

  const totals = calculateBillTotals(input.lines, input.currency, rateByCode);

  let billId: string;
  let billNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(bills)
      .set({
        supplierContactId: input.supplierContactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: input.currency,
        apAccountId: input.apAccountId,
        memo: input.memo ?? null,
        supplierReference: input.supplierReference ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, existingId))
      .returning({ id: bills.id, billNumber: bills.billNumber });
    if (!updated) throw new Error("Failed to update bill.");
    billId = updated.id;
    billNumber = updated.billNumber;
    await tx.delete(billLines).where(eq(billLines.billId, existingId));
  } else {
    billNumber = await nextBillNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(bills)
      .values({
        organizationId: actor.organizationId,
        supplierContactId: input.supplierContactId,
        billNumber,
        supplierReference: input.supplierReference ?? null,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
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
      .returning({ id: bills.id });
    if (!created) throw new Error("Failed to create bill.");
    billId = created.id;
  }

  await tx.insert(billLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      billId,
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
    action: existingId ? "bill.updated" : "bill.draft_created",
    entityType: "Bill",
    entityId: billId,
    after: { billNumber, supplier: supplier.displayName, ...totals },
  });

  return { id: billId, billNumber };
}

export const BillService = {
  async list(actor: Actor, opts: { status?: BillStatus; supplierContactId?: string } = {}) {
    assertPermission(actor, "supplier_bill:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(bills.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(bills.status, opts.status));
      if (opts.supplierContactId) conditions.push(eq(bills.supplierContactId, opts.supplierContactId));

      const rows = await tx
        .select({ bill: bills, supplier: contacts })
        .from(bills)
        .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
        .where(and(...conditions))
        .orderBy(desc(bills.issueDate), desc(bills.billNumber));

      return Promise.all(
        rows.map(async (row) => {
          const allocated = await loadAllocatedTotal(tx, actor.organizationId, row.bill.id);
          return { ...row.bill, supplier: row.supplier, amountPaid: allocated };
        }),
      );
    });
  },

  async get(actor: Actor, billId: string) {
    assertPermission(actor, "supplier_bill:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ bill: bills, supplier: contacts })
        .from(bills)
        .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
        .where(and(eq(bills.id, billId), eq(bills.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: billLines, account: accounts, taxCode: taxCodes })
        .from(billLines)
        .innerJoin(accounts, eq(accounts.id, billLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, billLines.taxCodeId))
        .where(eq(billLines.billId, billId))
        .orderBy(asc(billLines.lineNumber));

      const allocations = await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(and(eq(supplierPaymentAllocations.organizationId, actor.organizationId), eq(supplierPaymentAllocations.billId, billId)));

      const amountPaid = await loadAllocatedTotal(tx, actor.organizationId, billId);

      return {
        ...row.bill,
        supplier: row.supplier,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
        allocations,
        amountPaid,
      };
    });
  },

  async create(actor: Actor, input: CreateBillInput) {
    assertPermission(actor, "supplier_bill:manage");
    return withTenant(actor.organizationId, (tx) => persistBillWithLines(tx, actor, input));
  },

  async update(actor: Actor, billId: string, input: UpdateBillInput) {
    assertPermission(actor, "supplier_bill:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadBillOr404(tx, actor.organizationId, billId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new BillNotEditableError(existing.billNumber);
      }
      return persistBillWithLines(tx, actor, input, billId);
    });
  },

  async deleteDraft(actor: Actor, billId: string) {
    assertPermission(actor, "supplier_bill:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadBillOr404(tx, actor.organizationId, billId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new BillNotEditableError(existing.billNumber);
      }
      await tx.delete(bills).where(eq(bills.id, billId));
      await AuditService.record(tx, actor, {
        action: "bill.draft_deleted",
        entityType: "Bill",
        entityId: billId,
        before: { billNumber: existing.billNumber },
      });
    });
  },

  /**
   * Approves and posts a draft bill: debits each line's expense/asset
   * account for its `lineAmount`, debits each tax code's receivable (input
   * tax credit) account for the summed `taxAmount`, and credits the bill's
   * AP control account for the total — all through
   * `PostingService.postJournal`, so this inherits every ledger invariant
   * (balance, period-lock, immutability) for free rather than
   * re-implementing any of them. Never posts directly to `journal_lines`.
   */
  async approveAndPost(actor: Actor, billId: string) {
    assertPermission(actor, "supplier_bill:post");
    return withTenant(actor.organizationId, async (tx) => {
      const bill = await loadBillOr404(tx, actor.organizationId, billId);
      if (bill.status !== "DRAFT") {
        throw new BillNotDraftError(bill.billNumber);
      }

      const lines = await tx
        .select()
        .from(billLines)
        .where(eq(billLines.billId, billId))
        .orderBy(asc(billLines.lineNumber));
      if (lines.length === 0) {
        throw new InvalidBillLineError("A bill needs at least one line before it can be posted.");
      }

      const taxCodeIds = lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
      const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);

      // Debit expense/asset accounts, one line per distinct account (a
      // multi-line bill hitting the same account collapses into one debit).
      const expenseByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        const running = expenseByAccount.get(line.accountId) ?? Money.zero(bill.currency);
        expenseByAccount.set(line.accountId, running.add(Money.of(line.lineAmount, bill.currency)));
      }

      // Debit tax input-credit accounts, one line per distinct tax code's account.
      const taxByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        if (!line.taxCodeId) continue;
        const taxAmount = Money.of(line.taxAmount, bill.currency);
        if (taxAmount.isZero()) continue;
        const taxCode = taxCodesById.get(line.taxCodeId);
        if (!taxCode) throw new InvalidBillLineError(`Unknown tax code on bill line ${line.lineNumber}.`);
        if (!taxCode.receivableAccountId) {
          throw new TaxCodeMissingReceivableAccountError(taxCode.code);
        }
        const running = taxByAccount.get(taxCode.receivableAccountId) ?? Money.zero(bill.currency);
        taxByAccount.set(taxCode.receivableAccountId, running.add(taxAmount));
      }

      const total = Money.of(bill.total, bill.currency);

      const journalLines: JournalLineDraft[] = [
        ...[...expenseByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: bill.currency,
          contactId: bill.supplierContactId,
        })),
        ...[...taxByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: bill.currency,
        })),
        { accountId: bill.apAccountId, credit: total.toString(), currency: bill.currency, contactId: bill.supplierContactId },
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: bill.issueDate,
        memo: `Bill ${bill.billNumber}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      const [updated] = await tx
        .update(bills)
        .set({
          status: "APPROVED",
          journalEntryId: posted.entryId,
          postedAt: new Date(),
          postedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, billId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "bill.posted",
        entityType: "Bill",
        entityId: billId,
        before: { status: "DRAFT" },
        after: { status: "APPROVED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /**
   * Corrects a posted bill by reversing its posting journal — the bill's
   * own amounts are never edited, per docs/accounting-engine.md §1's
   * reversal-only rule. Refuses while any payment is still allocated, so
   * the fix is always "unallocate, then void", never "void out from under
   * an allocation".
   */
  async voidBill(actor: Actor, billId: string, reason: string) {
    assertPermission(actor, "supplier_bill:void");
    return withTenant(actor.organizationId, async (tx) => {
      const bill = await loadBillOr404(tx, actor.organizationId, billId);
      if (bill.status === "VOID") throw new BillAlreadyVoidError(bill.billNumber);
      if (bill.status === "DRAFT" || !bill.journalEntryId) {
        throw new BillNotPostedError(bill.billNumber);
      }

      const allocated = await loadAllocatedTotal(tx, actor.organizationId, billId);
      if (!Money.of(allocated, bill.currency).isZero()) {
        throw new BillHasPaymentsError(bill.billNumber);
      }

      const reversal = await PostingService.reverseEntry(actor, bill.journalEntryId, reason);

      const [updated] = await tx
        .update(bills)
        .set({
          status: "VOID",
          voidJournalEntryId: reversal.entryId,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, billId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "bill.voided",
        entityType: "Bill",
        entityId: billId,
        before: { status: bill.status },
        after: { status: "VOID", reversalEntryId: reversal.entryId, reason },
      });

      return updated;
    });
  },
};
