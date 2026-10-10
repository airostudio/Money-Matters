import { and, desc, eq } from "drizzle-orm";
import { accounts, bankAccounts, bills, contacts, supplierPayments, supplierPaymentAllocations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  BillCurrencyMismatchError,
  BillNotFoundError,
  BillNotPostedForPaymentError,
  InvalidBillLineError,
  InvalidContactForBillError,
  SupplierAllocationExceedsOutstandingError,
  SupplierPaymentNotFoundError,
  SupplierPaymentOverAllocatedError,
} from "./errors";
import { loadAllocatedTotal } from "./bill-service";
import type { RecordSupplierPaymentInput } from "./types";

const PAID_LIKE_STATUSES = new Set(["APPROVED", "PART_PAID"]);

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

async function assertUsableAccount(tx: TenantDb, organizationId: string, accountId: string) {
  const [account] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new InvalidBillLineError(`Account ${accountId} does not exist in this organization.`);
  if (!account.isActive) throw new InvalidBillLineError(`Account ${accountId} is inactive.`);
}

/** Recomputes and persists a bill's PART_PAID/PAID status from its actual allocation total — never trusts a caller's belief about it. */
async function refreshBillStatus(tx: TenantDb, actor: Actor, billId: string): Promise<void> {
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId));
  if (!bill || !PAID_LIKE_STATUSES.has(bill.status)) return;

  const allocated = await loadAllocatedTotal(tx, actor.organizationId, billId);
  const total = Money.of(bill.total, bill.currency);
  const paid = Money.of(allocated, bill.currency);

  const nextStatus = paid.compareTo(total) >= 0 ? "PAID" : paid.isPositive() ? "PART_PAID" : bill.status;
  if (nextStatus === bill.status) return;

  await tx
    .update(bills)
    .set({ status: nextStatus, updatedById: actor.userId, updatedAt: new Date() })
    .where(eq(bills.id, billId));

  await AuditService.record(tx, actor, {
    action: "bill.payment_status_updated",
    entityType: "Bill",
    entityId: billId,
    before: { status: bill.status },
    after: { status: nextStatus, amountPaid: allocated },
  });
}

export const SupplierPaymentAllocationService = {
  async list(actor: Actor, opts: { supplierContactId?: string } = {}) {
    assertPermission(actor, "supplier_payment:read");
    return withTenant(actor.organizationId, (tx) => {
      const conditions = [eq(supplierPayments.organizationId, actor.organizationId)];
      if (opts.supplierContactId) conditions.push(eq(supplierPayments.supplierContactId, opts.supplierContactId));
      return tx
        .select({ payment: supplierPayments, supplier: contacts })
        .from(supplierPayments)
        .innerJoin(contacts, eq(contacts.id, supplierPayments.supplierContactId))
        .where(and(...conditions))
        .orderBy(desc(supplierPayments.paymentDate));
    });
  },

  async get(actor: Actor, paymentId: string) {
    assertPermission(actor, "supplier_payment:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ payment: supplierPayments, supplier: contacts })
        .from(supplierPayments)
        .innerJoin(contacts, eq(contacts.id, supplierPayments.supplierContactId))
        .where(and(eq(supplierPayments.id, paymentId), eq(supplierPayments.organizationId, actor.organizationId)));
      if (!row) return null;

      const allocations = await tx
        .select({ allocation: supplierPaymentAllocations, bill: bills })
        .from(supplierPaymentAllocations)
        .innerJoin(bills, eq(bills.id, supplierPaymentAllocations.billId))
        .where(eq(supplierPaymentAllocations.paymentId, paymentId));

      return { ...row.payment, supplier: row.supplier, allocations };
    });
  },

  /**
   * Records a payment made to a supplier and allocates it across one or
   * more posted bills in a single transaction, then posts the balanced
   * ledger effect (debit each allocated bill's AP account, credit the
   * payment account) via `PostingService` — never a direct `journal_lines`
   * write. Enforces, explicitly rather than by hoping the caller got the
   * math right:
   *   1. sum(allocations) <= payment.amount ("payment allocation cannot
   *      exceed available payment")
   *   2. each allocation <= that bill's own outstanding balance, computed
   *      fresh from `supplier_payment_allocations` (never a denormalized
   *      counter that could have drifted)
   */
  async recordPayment(actor: Actor, input: RecordSupplierPaymentInput) {
    assertPermission(actor, "supplier_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await assertActiveSupplier(tx, actor.organizationId, input.supplierContactId);
      await assertUsableAccount(tx, actor.organizationId, input.paymentAccountId);

      if (input.bankAccountId) {
        const [bankAccount] = await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.organizationId, actor.organizationId)));
        if (!bankAccount) throw new InvalidBillLineError(`Bank account ${input.bankAccountId} was not found.`);
      }

      const paymentAmount = Money.of(input.amount, input.currency);
      if (!paymentAmount.isPositive()) {
        throw new InvalidBillLineError("Payment amount must be greater than zero.");
      }
      if (input.allocations.length === 0) {
        throw new InvalidBillLineError("A payment needs at least one allocation.");
      }

      let allocatedSoFar = Money.zero(input.currency);
      const debitByApAccount = new Map<string, Money>();
      const preparedAllocations: Array<{ billId: string; amount: string; billNumber: string }> = [];

      for (const allocation of input.allocations) {
        const [bill] = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.id, allocation.billId), eq(bills.organizationId, actor.organizationId)));
        if (!bill) throw new BillNotFoundError(allocation.billId);
        if (bill.status === "DRAFT" || bill.status === "VOID") {
          throw new BillNotPostedForPaymentError(bill.billNumber);
        }
        if (bill.currency !== input.currency) {
          throw new BillCurrencyMismatchError(bill.billNumber);
        }

        const allocationAmount = Money.of(allocation.amount, input.currency);
        if (!allocationAmount.isPositive()) {
          throw new InvalidBillLineError(`Allocation to bill ${bill.billNumber} must be greater than zero.`);
        }

        const alreadyAllocated = Money.of(
          await loadAllocatedTotal(tx, actor.organizationId, bill.id),
          bill.currency,
        );
        const outstanding = Money.of(bill.total, bill.currency).subtract(alreadyAllocated);
        if (allocationAmount.compareTo(outstanding) > 0) {
          throw new SupplierAllocationExceedsOutstandingError(bill.billNumber, outstanding.toString(), allocationAmount.toString());
        }

        allocatedSoFar = allocatedSoFar.add(allocationAmount);
        const running = debitByApAccount.get(bill.apAccountId) ?? Money.zero(input.currency);
        debitByApAccount.set(bill.apAccountId, running.add(allocationAmount));
        preparedAllocations.push({ billId: bill.id, amount: allocationAmount.toString(), billNumber: bill.billNumber });
      }

      // Invariant: the sum of allocations never exceeds the payment's own amount.
      if (allocatedSoFar.compareTo(paymentAmount) > 0) {
        throw new SupplierPaymentOverAllocatedError();
      }

      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          organizationId: actor.organizationId,
          supplierContactId: input.supplierContactId,
          paymentDate: input.paymentDate,
          amount: paymentAmount.toString(),
          currency: input.currency,
          method: input.method,
          paymentAccountId: input.paymentAccountId,
          bankAccountId: input.bankAccountId ?? null,
          reference: input.reference ?? null,
          createdById: actor.userId,
        })
        .returning();
      if (!payment) throw new Error("Failed to record payment.");

      await tx.insert(supplierPaymentAllocations).values(
        preparedAllocations.map((a) => ({
          organizationId: actor.organizationId,
          paymentId: payment.id,
          billId: a.billId,
          amount: a.amount,
          createdById: actor.userId,
        })),
      );

      const journalLines: JournalLineDraft[] = [
        ...[...debitByApAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: input.currency,
          contactId: input.supplierContactId,
        })),
        { accountId: input.paymentAccountId, credit: allocatedSoFar.toString(), currency: input.currency },
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: input.paymentDate,
        memo: `Payment to supplier${input.reference ? ` (${input.reference})` : ""}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      await tx.update(supplierPayments).set({ journalEntryId: posted.entryId }).where(eq(supplierPayments.id, payment.id));

      for (const allocation of preparedAllocations) {
        await refreshBillStatus(tx, actor, allocation.billId);
      }

      await AuditService.record(tx, actor, {
        action: "supplier_payment.recorded",
        entityType: "SupplierPayment",
        entityId: payment.id,
        after: {
          amount: paymentAmount.toString(),
          currency: input.currency,
          allocations: preparedAllocations,
          journalEntryId: posted.entryId,
        },
      });

      return { ...payment, journalEntryId: posted.entryId, entryNumber: posted.entryNumber, allocations: preparedAllocations };
    });
  },

  /**
   * Removes one allocation from a payment — the escape hatch that makes
   * voiding a paid bill possible (`BillService.voidBill` refuses while
   * anything is still allocated). Does not touch the payment's original
   * posting journal (the payment itself may still be applied elsewhere); it
   * only frees the bill's outstanding balance back up and recomputes its
   * status.
   */
  async removeAllocation(actor: Actor, paymentId: string, billId: string) {
    assertPermission(actor, "supplier_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [allocation] = await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(
          and(
            eq(supplierPaymentAllocations.organizationId, actor.organizationId),
            eq(supplierPaymentAllocations.paymentId, paymentId),
            eq(supplierPaymentAllocations.billId, billId),
          ),
        );
      if (!allocation) throw new SupplierPaymentNotFoundError(paymentId);

      await tx.delete(supplierPaymentAllocations).where(eq(supplierPaymentAllocations.id, allocation.id));

      await AuditService.record(tx, actor, {
        action: "supplier_payment.allocation_removed",
        entityType: "SupplierPayment",
        entityId: paymentId,
        before: { billId, amount: allocation.amount },
      });

      const [bill] = await tx.select().from(bills).where(eq(bills.id, billId));
      if (bill) {
        const allocated = await loadAllocatedTotal(tx, actor.organizationId, billId);
        const total = Money.of(bill.total, bill.currency);
        const paid = Money.of(allocated, bill.currency);
        const nextStatus = paid.isZero() ? "APPROVED" : paid.compareTo(total) >= 0 ? "PAID" : "PART_PAID";
        if (nextStatus !== bill.status && bill.status !== "VOID" && bill.status !== "DRAFT") {
          await tx
            .update(bills)
            .set({ status: nextStatus, updatedById: actor.userId, updatedAt: new Date() })
            .where(eq(bills.id, billId));
        }
      }
    });
  },
};
