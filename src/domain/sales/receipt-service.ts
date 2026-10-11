import { and, eq } from "drizzle-orm";
import {
  accounts,
  contacts,
  customerPaymentReceipts,
  invoices,
  organizations,
  paymentAllocations,
  payments,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PaymentNotFoundError } from "./errors";
import { nextReceiptNumber } from "./numbering";

/**
 * What a receipt said when it was issued. Stored as JSON on `customer_payment_receipts` and never rewritten, so a
 * receipt printed today and one printed next year are identical even if the unapplied balance has since been applied.
 */
export interface ReceiptSnapshot {
  schemaVersion: 1;
  organizationName: string;
  customerName: string;
  customerTaxNumber: string | null;
  paymentDate: string;
  amount: string;
  currency: string;
  method: string;
  reference: string | null;
  depositAccount: string;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }>;
  allocatedTotal: string;
  /** The part of the payment not allocated to an invoice when the receipt was issued (customer credit). */
  unappliedAtIssue: string;
}

export interface PaymentReceipt {
  id: string;
  paymentId: string;
  receiptNumber: string;
  issuedAt: Date;
  snapshot: ReceiptSnapshot;
  /** Live balance still unapplied TODAY, shown separately from the frozen snapshot. */
  unappliedNow: string;
}

/**
 * Issues the receipt for a payment inside the caller's transaction. Idempotent: a payment has at most one receipt
 * (unique on payment_id); asking again returns the existing one untouched. Only INSERTs - the table is granted
 * SELECT + INSERT only.
 */
export async function issueReceiptIn(tx: TenantDb, actor: Actor, paymentId: string): Promise<{ id: string; receiptNumber: string; created: boolean }> {
  const [existing] = await tx
    .select({ id: customerPaymentReceipts.id, receiptNumber: customerPaymentReceipts.receiptNumber })
    .from(customerPaymentReceipts)
    .where(and(eq(customerPaymentReceipts.organizationId, actor.organizationId), eq(customerPaymentReceipts.paymentId, paymentId)));
  if (existing) return { ...existing, created: false };

  const [row] = await tx
    .select({ payment: payments, customer: contacts, depositCode: accounts.code, depositName: accounts.name })
    .from(payments)
    .innerJoin(contacts, eq(contacts.id, payments.customerContactId))
    .innerJoin(accounts, eq(accounts.id, payments.depositAccountId))
    .where(and(eq(payments.id, paymentId), eq(payments.organizationId, actor.organizationId)));
  if (!row) throw new PaymentNotFoundError(paymentId);
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.organizationId));

  const allocs = await tx
    .select({ invoiceId: paymentAllocations.invoiceId, invoiceNumber: invoices.invoiceNumber, amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(and(eq(paymentAllocations.organizationId, actor.organizationId), eq(paymentAllocations.paymentId, paymentId)));

  const currency = row.payment.currency;
  const allocatedTotal = allocs.reduce((sum, a) => sum.add(Money.of(a.amount, currency)), Money.zero(currency));
  const unapplied = Money.of(row.payment.amount, currency).subtract(allocatedTotal);

  const snapshot: ReceiptSnapshot = {
    schemaVersion: 1,
    organizationName: org?.name ?? "",
    customerName: row.customer.displayName,
    customerTaxNumber: row.customer.taxNumber,
    paymentDate: row.payment.paymentDate.toISOString().slice(0, 10),
    amount: Money.of(row.payment.amount, currency).toString(),
    currency,
    method: row.payment.method,
    reference: row.payment.reference,
    depositAccount: `${row.depositCode} ${row.depositName}`,
    allocations: allocs
      .map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, amount: Money.of(a.amount, currency).toString() }))
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
    allocatedTotal: allocatedTotal.toString(),
    unappliedAtIssue: unapplied.toString(),
  };

  const receiptNumber = await nextReceiptNumber(tx, actor.organizationId);
  const [created] = await tx
    .insert(customerPaymentReceipts)
    .values({
      organizationId: actor.organizationId,
      paymentId,
      receiptNumber,
      snapshot,
      issuedById: actor.type === "SYSTEM" ? null : actor.userId,
    })
    .returning({ id: customerPaymentReceipts.id });
  if (!created) throw new Error("Failed to issue receipt.");

  await AuditService.record(tx, actor, {
    action: "customer_receipt.issued",
    entityType: "Payment",
    entityId: paymentId,
    after: { receiptNumber, amount: snapshot.amount, unappliedAtIssue: snapshot.unappliedAtIssue },
  });

  return { id: created.id, receiptNumber, created: true };
}

export const ReceiptService = {
  /**
   * The receipt for a payment. A payment recorded after the sales documents slice already has one (issued in the same
   * transaction as the payment). A payment recorded BEFORE it has none until someone first opens it, at which point it
   * is issued (once, idempotently, from the allocations stored at that moment) and audited as `customer_receipt.issued`.
   */
  async getForPayment(actor: Actor, paymentId: string): Promise<PaymentReceipt> {
    assertPermission(actor, "customer_payment:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [payment] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.organizationId, actor.organizationId)));
      if (!payment) throw new PaymentNotFoundError(paymentId);

      await issueReceiptIn(tx, actor, paymentId);

      const [receipt] = await tx
        .select()
        .from(customerPaymentReceipts)
        .where(and(eq(customerPaymentReceipts.organizationId, actor.organizationId), eq(customerPaymentReceipts.paymentId, paymentId)));
      if (!receipt) throw new PaymentNotFoundError(paymentId);

      const snapshot = receipt.snapshot as ReceiptSnapshot;
      const live = await tx
        .select({ amount: paymentAllocations.amount })
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.organizationId, actor.organizationId), eq(paymentAllocations.paymentId, paymentId)));
      const allocatedNow = live.reduce((sum, a) => sum.add(Money.of(a.amount, snapshot.currency)), Money.zero(snapshot.currency));

      return {
        id: receipt.id,
        paymentId,
        receiptNumber: receipt.receiptNumber,
        issuedAt: receipt.issuedAt,
        snapshot,
        unappliedNow: Money.of(snapshot.amount, snapshot.currency).subtract(allocatedNow).toString(),
      };
    });
  },
};
