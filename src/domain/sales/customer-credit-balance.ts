import { and, asc, eq, inArray } from "drizzle-orm";
import {
  customerCreditAllocations,
  customerCreditNotes,
  customerPaymentReceipts,
  paymentAllocations,
  payments,
} from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";

/**
 * A customer's UNAPPLIED credit - money the customer is owed against future invoices. Two sources, both of which
 * already sit inside the Accounts Receivable control account as a credit balance (no separate liability account):
 *   - a posted customer credit note not (fully) applied to invoices, and
 *   - a customer payment received in excess of what was allocated to invoices (an overpayment, a payment with no
 *     invoice, a deposit).
 * Computed fresh from the allocation tables on every read - never a stored counter that could drift.
 */
export interface UnappliedCreditItem {
  kind: "CREDIT_NOTE" | "PAYMENT";
  id: string;
  /** Credit note number, or the payment's receipt number (falling back to its reference). */
  label: string;
  date: Date;
  currency: string;
  total: string;
  applied: string;
  remaining: string;
}

/** Net amount applied from a credit note so far (reversals are negative rows, so this is a plain sum). */
export async function loadCreditNoteAppliedTotal(
  tx: TenantDb,
  organizationId: string,
  creditNoteId: string,
  currency: string,
): Promise<Money> {
  const rows = await tx
    .select({ amount: customerCreditAllocations.amount })
    .from(customerCreditAllocations)
    .where(
      and(eq(customerCreditAllocations.organizationId, organizationId), eq(customerCreditAllocations.creditNoteId, creditNoteId)),
    );
  return rows.reduce((sum, r) => sum.add(Money.of(r.amount, currency)), Money.zero(currency));
}

/** Total allocated from a payment to invoices so far. */
export async function loadPaymentAllocatedTotal(
  tx: TenantDb,
  organizationId: string,
  paymentId: string,
  currency: string,
): Promise<Money> {
  const rows = await tx
    .select({ amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.paymentId, paymentId)));
  return rows.reduce((sum, r) => sum.add(Money.of(r.amount, currency)), Money.zero(currency));
}

/** All of a customer's unapplied credit, oldest first. Four set-based queries regardless of how many documents. */
export async function loadUnappliedCredits(
  tx: TenantDb,
  organizationId: string,
  customerContactId: string,
): Promise<UnappliedCreditItem[]> {
  const items: UnappliedCreditItem[] = [];

  const notes = await tx
    .select()
    .from(customerCreditNotes)
    .where(
      and(
        eq(customerCreditNotes.organizationId, organizationId),
        eq(customerCreditNotes.customerContactId, customerContactId),
        inArray(customerCreditNotes.status, ["APPROVED", "PART_APPLIED"]),
      ),
    )
    .orderBy(asc(customerCreditNotes.issueDate));
  if (notes.length > 0) {
    const allocs = await tx
      .select({ creditNoteId: customerCreditAllocations.creditNoteId, amount: customerCreditAllocations.amount })
      .from(customerCreditAllocations)
      .where(
        and(
          eq(customerCreditAllocations.organizationId, organizationId),
          inArray(customerCreditAllocations.creditNoteId, notes.map((n) => n.id)),
        ),
      );
    for (const note of notes) {
      const applied = allocs
        .filter((a) => a.creditNoteId === note.id)
        .reduce((sum, a) => sum.add(Money.of(a.amount, note.currency)), Money.zero(note.currency));
      const remaining = Money.of(note.total, note.currency).subtract(applied);
      if (!remaining.isPositive()) continue;
      items.push({
        kind: "CREDIT_NOTE",
        id: note.id,
        label: note.creditNoteNumber,
        date: note.issueDate,
        currency: note.currency,
        total: note.total,
        applied: applied.toString(),
        remaining: remaining.toString(),
      });
    }
  }

  const paid = await tx
    .select({ payment: payments, receiptNumber: customerPaymentReceipts.receiptNumber })
    .from(payments)
    .leftJoin(customerPaymentReceipts, eq(customerPaymentReceipts.paymentId, payments.id))
    .where(and(eq(payments.organizationId, organizationId), eq(payments.customerContactId, customerContactId)))
    .orderBy(asc(payments.paymentDate));
  if (paid.length > 0) {
    const allocs = await tx
      .select({ paymentId: paymentAllocations.paymentId, amount: paymentAllocations.amount })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.organizationId, organizationId),
          inArray(paymentAllocations.paymentId, paid.map((p) => p.payment.id)),
        ),
      );
    for (const { payment, receiptNumber } of paid) {
      const applied = allocs
        .filter((a) => a.paymentId === payment.id)
        .reduce((sum, a) => sum.add(Money.of(a.amount, payment.currency)), Money.zero(payment.currency));
      const remaining = Money.of(payment.amount, payment.currency).subtract(applied);
      if (!remaining.isPositive()) continue;
      items.push({
        kind: "PAYMENT",
        id: payment.id,
        label: receiptNumber ?? payment.reference ?? "Payment received",
        date: payment.paymentDate,
        currency: payment.currency,
        total: payment.amount,
        applied: applied.toString(),
        remaining: remaining.toString(),
      });
    }
  }

  return items.sort((a, b) => a.date.getTime() - b.date.getTime());
}
