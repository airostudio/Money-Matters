import { sql, eq } from "drizzle-orm";
import { customerCreditNotes, customerPaymentReceipts, invoices, quotes } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

/**
 * Sequential per-organization invoice numbers, e.g. "INV-000123" — same
 * approach and same caveat as `src/domain/ledger/numbering.ts`: derived from
 * a row count inside the same transaction as the insert, with the
 * (organizationId, invoiceNumber) unique index as the backstop against a
 * concurrent-create race.
 */
export async function nextInvoiceNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `INV-${String(count + 1).padStart(6, "0")}`;
}

/**
 * Sequential per-organization customer credit note numbers, "CN-000123" - their own sequence, separate from invoices.
 * Unlike `nextInvoiceNumber` (a row count, which can repeat after a draft is deleted) this takes the highest existing
 * number + 1 under a per-organization advisory lock, so a deleted draft never makes the next number collide.
 */
export async function nextCustomerCreditNumber(tx: TenantDb, organizationId: string): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"customer_credit_number:" + organizationId}))`);
  const [row] = await tx
    .select({
      max: sql<number>`coalesce(max(nullif(regexp_replace(${customerCreditNotes.creditNoteNumber}, '\\D', '', 'g'), '')::int), 0)::int`,
    })
    .from(customerCreditNotes)
    .where(eq(customerCreditNotes.organizationId, organizationId));
  return `CN-${String((row?.max ?? 0) + 1).padStart(6, "0")}`;
}

/** Sequential per-organization payment receipt numbers, "RCT-000123", same max+1-under-lock approach. */
export async function nextReceiptNumber(tx: TenantDb, organizationId: string): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"receipt_number:" + organizationId}))`);
  const [row] = await tx
    .select({
      max: sql<number>`coalesce(max(nullif(regexp_replace(${customerPaymentReceipts.receiptNumber}, '\\D', '', 'g'), '')::int), 0)::int`,
    })
    .from(customerPaymentReceipts)
    .where(eq(customerPaymentReceipts.organizationId, organizationId));
  return `RCT-${String((row?.max ?? 0) + 1).padStart(6, "0")}`;
}

/** Sequential per-organization quote numbers, e.g. "QUO-000123" — same approach as `nextInvoiceNumber`. */
export async function nextQuoteNumber(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(quotes)
    .where(eq(quotes.organizationId, organizationId));

  const count = row?.count ?? 0;
  return `QUO-${String(count + 1).padStart(6, "0")}`;
}
