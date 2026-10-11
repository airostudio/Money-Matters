import { adminDb } from "./db";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  bills,
  contacts,
  employees,
  invoices,
  payments,
  products,
  projects,
  purchaseOrders,
  quotes,
  supplierPayments,
} from "@/db/schema";

/**
 * Seeds one record of every searchable kind for an organization, every one carrying the distinctive `token`
 * ("Zephyr" in the tests) so a single query finds them all. Rows go in through the superuser connection (the
 * point is the search, not the posting engine), with only the columns the search and its links need.
 */
export async function seedSearchData(organizationId: string, token: string, opts: { amount?: string } = {}) {
  const db = adminDb();
  const amount = opts.amount ?? "1234.5000";
  const now = new Date("2026-03-10T00:00:00Z");
  const due = new Date("2026-04-10T00:00:00Z");

  const [customer] = await db
    .insert(contacts)
    .values({ organizationId, kind: "CUSTOMER", displayName: `${token} Customer Pty Ltd`, email: `${token.toLowerCase()}-c@example.test`, currency: "AUD" })
    .returning();
  const [supplier] = await db
    .insert(contacts)
    .values({ organizationId, kind: "SUPPLIER", displayName: `${token} Supplier Pty Ltd`, email: `${token.toLowerCase()}-s@example.test`, currency: "AUD", taxNumber: "11 111 111 111" })
    .returning();
  const [asset] = await db
    .insert(accounts)
    .values({ organizationId, code: `${token.slice(0, 3).toUpperCase()}-1000`, name: `${token} Bank`, type: "ASSET", currency: "AUD" })
    .returning();
  const [liability] = await db
    .insert(accounts)
    .values({ organizationId, code: `${token.slice(0, 3).toUpperCase()}-2000`, name: `${token} Payable`, type: "LIABILITY", currency: "AUD", isControlAccount: true })
    .returning();
  if (!customer || !supplier || !asset || !liability) throw new Error("seed failed");

  const [invoice] = await db
    .insert(invoices)
    .values({ organizationId, customerContactId: customer.id, invoiceNumber: `INV-${token}-1`, issueDate: now, dueDate: due, currency: "AUD", arAccountId: asset.id, status: "SENT", total: amount })
    .returning();
  const [quote] = await db
    .insert(quotes)
    .values({ organizationId, customerContactId: customer.id, quoteNumber: `QUO-${token}-1`, issueDate: now, expiryDate: due, currency: "AUD", status: "DRAFT", total: amount })
    .returning();
  const [bill] = await db
    .insert(bills)
    .values({ organizationId, supplierContactId: supplier.id, billNumber: `BILL-${token}-1`, supplierReference: `REF-${token}`, issueDate: now, dueDate: due, currency: "AUD", apAccountId: liability.id, status: "APPROVED", total: amount })
    .returning();
  const [po] = await db
    .insert(purchaseOrders)
    .values({ organizationId, supplierContactId: supplier.id, poNumber: `PO-${token}-1`, issueDate: now, currency: "AUD", status: "DRAFT", total: amount })
    .returning();
  const [payment] = await db
    .insert(payments)
    .values({ organizationId, customerContactId: customer.id, paymentDate: now, amount, currency: "AUD", depositAccountId: asset.id, reference: `RCPT-${token}` })
    .returning();
  const [supplierPayment] = await db
    .insert(supplierPayments)
    .values({ organizationId, supplierContactId: supplier.id, paymentDate: now, amount, currency: "AUD", paymentAccountId: asset.id, reference: `PAID-${token}` })
    .returning();
  const [employee] = await db
    .insert(employees)
    .values({
      organizationId,
      name: `${token} Employee`,
      employmentBasis: "SALARY",
      annualSalary: "99999.0000",
      payFrequency: "MONTHLY",
      startDate: now,
      tfn: "123456782",
      bankBsb: "062000",
      bankAccountNumber: "98765432",
      bankAccountName: `${token} Employee`,
    })
    .returning();
  const [bankAccount] = await db
    .insert(bankAccounts)
    .values({ organizationId, glAccountId: asset.id, name: `${token} Everyday`, currency: "AUD" })
    .returning();
  if (!bankAccount) throw new Error("seed failed");
  const [bankTxn] = await db
    .insert(bankTransactions)
    .values({ organizationId, bankAccountId: bankAccount.id, externalId: `ext-${token}-1`, postedDate: now, description: `${token} CARD PURCHASE`, amount: `-${amount}`, currency: "AUD", status: "UNMATCHED" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ organizationId, code: `PRJ-${token}`, name: `${token} Fitout`, currency: "AUD" })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ organizationId, sku: `SKU-${token}`, name: `${token} Widget`, type: "SERVICE", revenueAccountId: asset.id })
    .returning();

  return {
    customer, supplier, asset, liability, invoice, quote, bill, po, payment, supplierPayment, employee, bankAccount, bankTxn, project, product,
  };
}
