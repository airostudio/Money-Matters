import { and, desc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { accounts, bankAccounts, contacts, invoices, payments, paymentAllocations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { DomainEventService } from "@/domain/webhooks/domain-events";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  AllocationExceedsOutstandingError,
  CustomerCreditCurrencyMismatchError,
  CustomerCreditCustomerMismatchError,
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  InvoiceCurrencyMismatchError,
  InvoiceNotFoundError,
  InvoiceNotPostedForPaymentError,
  PaymentNeedsReceivableAccountError,
  PaymentNotFoundError,
  PaymentNotUnappliedError,
  PaymentOverAllocatedError,
} from "./errors";
import { loadAllocatedTotal } from "./invoice-service";
import { loadPaymentAllocatedTotal } from "./customer-credit-balance";
import { issueReceiptIn } from "./receipt-service";
import type { RecordPaymentInput } from "./types";

/** Statuses whose APPROVED / PART_PAID / PAID value is derived from allocations. */
const PAID_LIKE_STATUSES = new Set(["APPROVED", "SENT", "VIEWED", "PART_PAID", "PAID"]);

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

async function assertUsableAccount(tx: TenantDb, organizationId: string, accountId: string) {
  const [account] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new InvalidInvoiceLineError(`Account ${accountId} does not exist in this organization.`);
  if (!account.isActive) throw new InvalidInvoiceLineError(`Account ${accountId} is inactive.`);
}

/**
 * Recomputes and persists an invoice's APPROVED / PART_PAID / PAID status from its actual allocation total (cash
 * allocations plus customer credit applications, in either direction) - never trusts a caller's belief about it.
 * Exported so credit-note application and reversal use exactly the same rule as payments.
 */
export async function refreshInvoiceStatus(tx: TenantDb, actor: Actor, invoiceId: string): Promise<void> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice || !PAID_LIKE_STATUSES.has(invoice.status)) return;

  const allocated = await loadAllocatedTotal(tx, actor.organizationId, invoiceId);
  const total = Money.of(invoice.total, invoice.currency);
  const paid = Money.of(allocated, invoice.currency);

  const nextStatus =
    paid.compareTo(total) >= 0
      ? "PAID"
      : paid.isPositive()
        ? "PART_PAID"
        : invoice.status === "PAID" || invoice.status === "PART_PAID"
          ? "APPROVED"
          : invoice.status;
  if (nextStatus === invoice.status) return;

  await tx
    .update(invoices)
    .set({ status: nextStatus, updatedById: actor.userId, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));

  await AuditService.record(tx, actor, {
    action: "invoice.payment_status_updated",
    entityType: "Invoice",
    entityId: invoiceId,
    before: { status: invoice.status },
    after: { status: nextStatus, amountPaid: allocated },
  });

  // Phase 10 Slice 2: allocations now cover the invoice in full (a transition INTO PAID, never repeated).
  if (nextStatus === "PAID") await DomainEventService.emitInvoiceEventIn(tx, actor.organizationId, "invoice.paid", invoiceId);
}

export const PaymentAllocationService = {
  async list(actor: Actor, opts: { customerContactId?: string } = {}) {
    assertPermission(actor, "customer_payment:read");
    return withTenant(actor.organizationId, (tx) => {
      const conditions = [eq(payments.organizationId, actor.organizationId)];
      if (opts.customerContactId) conditions.push(eq(payments.customerContactId, opts.customerContactId));
      return tx
        .select({ payment: payments, customer: contacts })
        .from(payments)
        .innerJoin(contacts, eq(contacts.id, payments.customerContactId))
        .where(and(...conditions))
        .orderBy(desc(payments.paymentDate));
    });
  },

  async get(actor: Actor, paymentId: string) {
    assertPermission(actor, "customer_payment:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ payment: payments, customer: contacts })
        .from(payments)
        .innerJoin(contacts, eq(contacts.id, payments.customerContactId))
        .where(and(eq(payments.id, paymentId), eq(payments.organizationId, actor.organizationId)));
      if (!row) return null;

      const allocations = await tx
        .select({ allocation: paymentAllocations, invoice: invoices })
        .from(paymentAllocations)
        .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .where(eq(paymentAllocations.paymentId, paymentId));

      return { ...row.payment, customer: row.customer, allocations };
    });
  },

  /**
   * Records a receipt from a customer and allocates it across one or more
   * posted invoices in a single transaction, then posts the balanced
   * ledger effect (debit the deposit account, credit each allocated
   * invoice's AR account) via `PostingService` — never a direct
   * `journal_lines` write. Enforces, explicitly rather than by hoping the
   * caller got the math right:
   *   1. sum(allocations) <= payment.amount ("payment allocation cannot
   *      exceed available payment" — master spec AR invariant)
   *   2. each allocation <= that invoice's own outstanding balance, computed
   *      fresh from `payment_allocations` (never a denormalized counter that
   *      could have drifted)
   */
  async recordPayment(actor: Actor, input: RecordPaymentInput) {
    assertPermission(actor, "customer_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await assertActiveCustomer(tx, actor.organizationId, input.customerContactId);
      await assertUsableAccount(tx, actor.organizationId, input.depositAccountId);

      if (input.bankAccountId) {
        const [bankAccount] = await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.organizationId, actor.organizationId)));
        if (!bankAccount) throw new InvalidInvoiceLineError(`Bank account ${input.bankAccountId} was not found.`);
      }

      const paymentAmount = Money.of(input.amount, input.currency);
      if (!paymentAmount.isPositive()) {
        throw new InvalidInvoiceLineError("Payment amount must be greater than zero.");
      }

      let allocatedSoFar = Money.zero(input.currency);
      const creditByArAccount = new Map<string, Money>();
      const preparedAllocations: Array<{ invoiceId: string; amount: string; invoiceNumber: string }> = [];
      let firstArAccountId: string | undefined;

      for (const allocation of input.allocations) {
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, allocation.invoiceId), eq(invoices.organizationId, actor.organizationId)));
        if (!invoice) throw new InvoiceNotFoundError(allocation.invoiceId);
        if (invoice.status === "DRAFT" || invoice.status === "VOID") {
          throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);
        }
        if (invoice.currency !== input.currency) {
          throw new InvoiceCurrencyMismatchError(invoice.invoiceNumber);
        }

        const allocationAmount = Money.of(allocation.amount, input.currency);
        if (!allocationAmount.isPositive()) {
          throw new InvalidInvoiceLineError(`Allocation to invoice ${invoice.invoiceNumber} must be greater than zero.`);
        }

        const alreadyAllocated = Money.of(
          await loadAllocatedTotal(tx, actor.organizationId, invoice.id),
          invoice.currency,
        );
        const outstanding = Money.of(invoice.total, invoice.currency).subtract(alreadyAllocated);
        if (allocationAmount.compareTo(outstanding) > 0) {
          throw new AllocationExceedsOutstandingError(invoice.invoiceNumber, outstanding.toString(), allocationAmount.toString());
        }

        allocatedSoFar = allocatedSoFar.add(allocationAmount);
        firstArAccountId ??= invoice.arAccountId;
        const running = creditByArAccount.get(invoice.arAccountId) ?? Money.zero(input.currency);
        creditByArAccount.set(invoice.arAccountId, running.add(allocationAmount));
        preparedAllocations.push({ invoiceId: invoice.id, amount: allocationAmount.toString(), invoiceNumber: invoice.invoiceNumber });
      }

      // Invariant: the sum of allocations never exceeds the payment's own amount.
      if (allocatedSoFar.compareTo(paymentAmount) > 0) {
        throw new PaymentOverAllocatedError();
      }

      // Sales documents slice: whatever part of the payment is not allocated to an invoice (an overpayment, a payment
      // with no invoice, a deposit) is credited to the customer's Accounts Receivable as a credit balance - an
      // UNAPPLIED customer credit that can be applied to an invoice later. Previously only the allocated part was
      // posted, which left the bank debit short of the cash actually received.
      const unallocated = paymentAmount.subtract(allocatedSoFar);
      if (unallocated.isPositive()) {
        const creditAccountId = input.arAccountId ?? firstArAccountId;
        if (!creditAccountId) throw new PaymentNeedsReceivableAccountError();
        await assertUsableAccount(tx, actor.organizationId, creditAccountId);
        creditByArAccount.set(creditAccountId, (creditByArAccount.get(creditAccountId) ?? Money.zero(input.currency)).add(unallocated));
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          organizationId: actor.organizationId,
          customerContactId: input.customerContactId,
          paymentDate: input.paymentDate,
          amount: paymentAmount.toString(),
          currency: input.currency,
          method: input.method,
          depositAccountId: input.depositAccountId,
          bankAccountId: input.bankAccountId ?? null,
          reference: input.reference ?? null,
          createdById: actor.userId,
        })
        .returning();
      if (!payment) throw new Error("Failed to record payment.");

      if (preparedAllocations.length > 0) {
        await tx.insert(paymentAllocations).values(
          preparedAllocations.map((a) => ({
            organizationId: actor.organizationId,
            paymentId: payment.id,
            invoiceId: a.invoiceId,
            amount: a.amount,
            createdById: actor.userId,
          })),
        );
      }

      // Phase 10 Slice 2: `payment.received` commits with the payment (and precedes any `invoice.paid` it causes below).
      await DomainEventService.emitPaymentReceivedIn(tx, actor.organizationId, payment.id);

      const journalLines: JournalLineDraft[] = [
        { accountId: input.depositAccountId, debit: paymentAmount.toString(), currency: input.currency },
        ...[...creditByArAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          credit: amount.toString(),
          currency: input.currency,
          contactId: input.customerContactId,
        })),
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: input.paymentDate,
        memo: `Payment from customer${input.reference ? ` (${input.reference})` : ""}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      await tx.update(payments).set({ journalEntryId: posted.entryId }).where(eq(payments.id, payment.id));

      for (const allocation of preparedAllocations) {
        await refreshInvoiceStatus(tx, actor, allocation.invoiceId);
      }

      await AuditService.record(tx, actor, {
        action: "customer_payment.recorded",
        entityType: "Payment",
        entityId: payment.id,
        after: {
          amount: paymentAmount.toString(),
          currency: input.currency,
          allocations: preparedAllocations,
          unallocated: unallocated.toString(),
          journalEntryId: posted.entryId,
        },
      });

      // The receipt is issued in the same transaction as the payment, from the allocations just stored.
      const receipt = await issueReceiptIn(tx, actor, payment.id);

      return {
        ...payment,
        journalEntryId: posted.entryId,
        entryNumber: posted.entryNumber,
        allocations: preparedAllocations,
        unallocated: unallocated.toString(),
        receiptNumber: receipt.receiptNumber,
      };
    });
  },

  /**
   * Removes one allocation from a payment — the escape hatch that makes
   * voiding a paid invoice possible (`InvoiceService.voidInvoice` refuses
   * while anything is still allocated). Does not touch the payment's
   * original posting journal (the payment itself may still be applied
   * elsewhere); it only frees the invoice's outstanding balance back up and
   * recomputes its status.
   */
  async removeAllocation(actor: Actor, paymentId: string, invoiceId: string) {
    assertPermission(actor, "customer_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(paymentAllocations)
        .where(
          and(
            eq(paymentAllocations.organizationId, actor.organizationId),
            eq(paymentAllocations.paymentId, paymentId),
            eq(paymentAllocations.invoiceId, invoiceId),
          ),
        );
      if (rows.length === 0) throw new PaymentNotFoundError(paymentId);

      // Every step this payment was applied to this invoice in (since the sales documents slice a receipt can be
      // applied in several steps). The freed amount returns to the customer's UNAPPLIED credit: the payment's
      // journal already credited Accounts Receivable, so no ledger entry is needed - it simply stops being matched.
      const freed = rows.reduce((sum, r) => sum.plus(r.amount), new Decimal(0)).toFixed(4);
      await tx.delete(paymentAllocations).where(inArray(paymentAllocations.id, rows.map((r) => r.id)));

      await AuditService.record(tx, actor, {
        action: "customer_payment.allocation_removed",
        entityType: "Payment",
        entityId: paymentId,
        before: { invoiceId, amount: freed, steps: rows.length },
      });

      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
      if (invoice) {
        // Re-widen the check in refreshInvoiceStatus to also cover PAID -> PART_PAID/APPROVED.
        const allocated = await loadAllocatedTotal(tx, actor.organizationId, invoiceId);
        const total = Money.of(invoice.total, invoice.currency);
        const paid = Money.of(allocated, invoice.currency);
        const nextStatus = paid.isZero() ? "APPROVED" : paid.compareTo(total) >= 0 ? "PAID" : "PART_PAID";
        if (nextStatus !== invoice.status && invoice.status !== "VOID" && invoice.status !== "DRAFT") {
          await tx
            .update(invoices)
            .set({ status: nextStatus, updatedById: actor.userId, updatedAt: new Date() })
            .where(eq(invoices.id, invoiceId));
        }
      }
    });
  },

  /**
   * Applies part or all of a payment's UNAPPLIED balance (an overpayment, a payment recorded with no invoice, a
   * deposit) to a posted invoice of the same customer. No ledger posting: the payment's own journal already credited
   * Accounts Receivable for the whole amount, so matching it to an invoice only changes which invoice it settles
   * (the sub-ledger), exactly like applying a credit note. Never exceeds the payment's unapplied balance or the
   * invoice's outstanding balance. The receipt issued for the payment is NOT rewritten.
   */
  async applyToInvoice(actor: Actor, paymentId: string, invoiceId: string, amount: string, appliedDate?: Date) {
    assertPermission(actor, "customer_payment:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.organizationId, actor.organizationId)))
        .for("update");
      if (!payment) throw new PaymentNotFoundError(paymentId);

      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, actor.organizationId)))
        .for("update");
      if (!invoice) throw new InvoiceNotFoundError(invoiceId);
      if (invoice.status === "DRAFT" || invoice.status === "VOID") throw new InvoiceNotPostedForPaymentError(invoice.invoiceNumber);
      if (invoice.customerContactId !== payment.customerContactId) {
        throw new CustomerCreditCustomerMismatchError("This payment", invoice.invoiceNumber);
      }
      if (invoice.currency !== payment.currency) throw new CustomerCreditCurrencyMismatchError("This payment", invoice.invoiceNumber);

      const applyAmount = Money.of(amount, payment.currency);
      if (!applyAmount.isPositive()) throw new InvalidInvoiceLineError("The amount to apply must be greater than zero.");

      const unapplied = Money.of(payment.amount, payment.currency).subtract(
        await loadPaymentAllocatedTotal(tx, actor.organizationId, paymentId, payment.currency),
      );
      if (applyAmount.compareTo(unapplied) > 0) throw new PaymentNotUnappliedError(unapplied.toString(), applyAmount.toString());

      const outstanding = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(await loadAllocatedTotal(tx, actor.organizationId, invoiceId), invoice.currency),
      );
      if (applyAmount.compareTo(outstanding) > 0) {
        throw new AllocationExceedsOutstandingError(invoice.invoiceNumber, outstanding.toString(), applyAmount.toString());
      }

      // The effective date can never precede either document (a receipt cannot settle an invoice before it exists).
      const requested = appliedDate ?? new Date();
      const effective = new Date(Math.max(requested.getTime(), payment.paymentDate.getTime(), invoice.issueDate.getTime()));

      await tx.insert(paymentAllocations).values({
        organizationId: actor.organizationId,
        paymentId,
        invoiceId,
        amount: applyAmount.toString(),
        appliedDate: effective,
        createdById: actor.userId,
      });

      await refreshInvoiceStatus(tx, actor, invoiceId);

      await AuditService.record(tx, actor, {
        action: "customer_payment.unapplied_applied",
        entityType: "Payment",
        entityId: paymentId,
        after: { invoiceId, invoiceNumber: invoice.invoiceNumber, amount: applyAmount.toString() },
      });

      return { paymentId, invoiceId, amount: applyAmount.toString() };
    });
  },
};
