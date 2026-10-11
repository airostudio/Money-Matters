import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { withTenant } from "@/db/tenant";
import { ContactService } from "@/domain/contacts/contact-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { CustomerCreditService } from "@/domain/sales/customer-credit-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { ReceiptService } from "@/domain/sales/receipt-service";
import { loadUnappliedCredits } from "@/domain/sales/customer-credit-balance";
import { ArControlReconciliationService, CustomerStatementService } from "@/domain/sales/statement-service";
import { statementToCsv } from "@/domain/sales/statement-csv";
import { AgedReceivablesService } from "@/domain/sales/aged-receivables-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

/**
 * Unapplied customer credit, receipts and statements - hand-worked.
 *
 *   INV-000001  2026-01-05  due 2026-02-04   1000.00 + 100.00 GST = 1100.00
 *   INV-000002  2026-02-10  due 2026-03-12    500.00 +  50.00 GST =  550.00
 *   CN-000001   2026-02-15                    100.00 +  10.00 GST =  110.00  (unapplied)
 *   PAYMENT     2026-02-20  1500.00 received, 1100.00 allocated to INV-000001 => 400.00 unallocated credit
 *
 *   Customer balance after each: 1100 -> 1650 -> 1540 -> 40.   Ledger AR = 1100 + 550 - 110 - 1500 = 40.
 */
describe("Unapplied customer credit, receipts and statements (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let currency: string;
  let fx: Awaited<ReturnType<typeof createSalesFixtures>>;
  let inv1: string;
  let inv2: string;
  let creditId: string;
  let paymentId: string;

  async function postInvoice(issue: string, due: string, unitPrice: string, customerContactId = fx.customerContactId) {
    const inv = await InvoiceService.create(owner, {
      customerContactId,
      issueDate: new Date(issue),
      dueDate: new Date(due),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "Work", quantity: "1", unitPrice, accountId: fx.revenueAccountId, taxCodeId: fx.taxCodeId }],
    });
    await InvoiceService.approveAndPost(owner, inv.id);
    return inv.id;
  }

  async function seed() {
    inv1 = await postInvoice("2026-01-05", "2026-02-04", "1000.00");
    inv2 = await postInvoice("2026-02-10", "2026-03-12", "500.00");
    const credit = await CustomerCreditService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date("2026-02-15"),
      currency,
      arAccountId: fx.arAccountId,
      invoiceId: inv1,
      lines: [{ description: "Discount", quantity: "1", unitPrice: "100.00", accountId: fx.revenueAccountId, taxCodeId: fx.taxCodeId }],
    });
    creditId = credit.id;
    await CustomerCreditService.approveAndPost(owner, creditId);
    const payment = await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fx.customerContactId,
      paymentDate: new Date("2026-02-20"),
      amount: "1500.00",
      currency,
      method: "BANK_TRANSFER",
      depositAccountId: fx.bankGlAccountId,
      reference: "BANK-REF-1",
      allocations: [{ invoiceId: inv1, amount: "1100.00" }],
    });
    paymentId = payment.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("customer-statements");
    owner = org.owner;
    orgId = org.organizationId;
    currency = org.baseCurrency;
    fx = await createSalesFixtures(owner, currency);
  });

  async function balance(accountId: string) {
    return (await LedgerService.getTrialBalance(owner)).find((r) => r.accountId === accountId)?.balance;
  }

  describe("overpayments and unapplied receipts", () => {
    it("posts the WHOLE receipt: bank debited 1500, AR credited 1500, leaving 400 as a credit on the customer", async () => {
      await seed();
      expect(await balance(fx.bankGlAccountId)).toBe("1500.0000");
      expect(await balance(fx.arAccountId)).toBe("40.0000"); // 1100 + 550 - 110 - 1500

      const items = await withTenant(orgId, (tx) => loadUnappliedCredits(tx, orgId, fx.customerContactId));
      expect(items.map((i) => [i.kind, i.remaining])).toEqual([
        ["CREDIT_NOTE", "110.0000"],
        ["PAYMENT", "400.0000"],
      ]);
      // The invoice itself is fully settled by the 1100 allocation.
      expect((await InvoiceService.get(owner, inv1))!.status).toBe("PAID");
    });

    it("a payment with no invoice (a deposit) needs an AR account, then sits entirely as unapplied credit", async () => {
      await expect(
        PaymentAllocationService.recordPayment(owner, {
          customerContactId: fx.customerContactId,
          paymentDate: new Date("2026-03-01"),
          amount: "300.00",
          currency,
          method: "CASH",
          depositAccountId: fx.bankGlAccountId,
          allocations: [],
        }),
      ).rejects.toThrow(/receivable account/);

      const deposit = await PaymentAllocationService.recordPayment(owner, {
        customerContactId: fx.customerContactId,
        paymentDate: new Date("2026-03-01"),
        amount: "300.00",
        currency,
        method: "CASH",
        depositAccountId: fx.bankGlAccountId,
        arAccountId: fx.arAccountId,
        allocations: [],
      });
      expect(deposit.unallocated).toBe("300.0000");
      expect(await balance(fx.bankGlAccountId)).toBe("300.0000");
      expect(await balance(fx.arAccountId)).toBe("-300.0000");

      const invoiceId = await postInvoice("2026-03-02", "2026-04-01", "200.00"); // 220.00
      await PaymentAllocationService.applyToInvoice(owner, deposit.id, invoiceId, "220.00");
      expect((await InvoiceService.get(owner, invoiceId))!.status).toBe("PAID");
      const items = await withTenant(orgId, (tx) => loadUnappliedCredits(tx, orgId, fx.customerContactId));
      expect(items.map((i) => i.remaining)).toEqual(["80.0000"]);
      // No ledger movement from applying: AR = -300 (deposit) + 220 (invoice) = -80.
      expect(await balance(fx.arAccountId)).toBe("-80.0000");
    });

    it("applies unapplied receipt money to an invoice in steps, never beyond the unapplied or the outstanding amount", async () => {
      await seed();
      await expect(PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "400.01")).rejects.toThrow(/only 400.0000/);
      await expect(PaymentAllocationService.applyToInvoice(owner, paymentId, inv1, "1.00")).rejects.toThrow(/outstanding/);

      await PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "150.00", new Date("2026-03-05"));
      await PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "250.00", new Date("2026-03-06"));
      const invoice = await InvoiceService.get(owner, inv2);
      expect(invoice!.amountPaid).toBe("400.0000");
      expect(invoice!.status).toBe("PART_PAID");
      await expect(PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "0.01")).rejects.toThrow(/only 0.0000/);
    });

    it("cannot be applied to another customer's invoice", async () => {
      await seed();
      const other = await ContactService.create(owner, { kind: "CUSTOMER", displayName: "Other Pty Ltd", currency });
      const otherInv = await postInvoice("2026-03-01", "2026-03-31", "50.00", other.id);
      await expect(PaymentAllocationService.applyToInvoice(owner, paymentId, otherInv, "10.00")).rejects.toThrow(/different customers/);
    });

    it("removing an allocation returns the money to unapplied credit (no ledger entry needed)", async () => {
      await seed();
      await PaymentAllocationService.removeAllocation(owner, paymentId, inv1);
      expect((await InvoiceService.get(owner, inv1))!.status).toBe("APPROVED");
      const items = await withTenant(orgId, (tx) => loadUnappliedCredits(tx, orgId, fx.customerContactId));
      expect(items.find((i) => i.kind === "PAYMENT")!.remaining).toBe("1500.0000");
      expect(await balance(fx.arAccountId)).toBe("40.0000");
    });

    it("applying a credit note and a receipt together settles an invoice, and permissions are enforced", async () => {
      await seed();
      await CustomerCreditService.applyToInvoice(owner, creditId, inv2, "110.00");
      await PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "400.00");
      const invoice = await InvoiceService.get(owner, inv2);
      expect(invoice!.amountPaid).toBe("510.0000");
      const readOnly = actorWithRole(owner, "READ_ONLY");
      await expect(PaymentAllocationService.applyToInvoice(readOnly, paymentId, inv2, "1.00")).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("receipts", () => {
    it("is issued with the payment, frozen at issue time, and immutable in the database", async () => {
      await seed();
      const receipt = await ReceiptService.getForPayment(owner, paymentId);
      expect(receipt.receiptNumber).toBe("RCT-000001");
      expect(receipt.snapshot).toMatchObject({
        customerName: "Acme Pty Ltd",
        paymentDate: "2026-02-20",
        amount: "1500.0000",
        reference: "BANK-REF-1",
        allocatedTotal: "1100.0000",
        unappliedAtIssue: "400.0000",
        allocations: [{ invoiceNumber: "INV-000001", amount: "1100.0000" }],
      });
      expect(receipt.unappliedNow).toBe("400.0000");

      // Applying the remaining credit later does not rewrite the receipt.
      await PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "400.00");
      const again = await ReceiptService.getForPayment(owner, paymentId);
      expect(again.receiptNumber).toBe("RCT-000001");
      expect(again.snapshot).toEqual(receipt.snapshot);
      expect(again.unappliedNow).toBe("0.0000");

      expect(await pgMessage(withTenant(orgId, (tx) => tx.execute(sql`UPDATE customer_payment_receipts SET receipt_number = 'X'`)))).toMatch(/permission denied/);
      expect(await pgMessage(withTenant(orgId, (tx) => tx.execute(sql`DELETE FROM customer_payment_receipts`)))).toMatch(/permission denied/);
    });

    it("a payment recorded before receipts existed gets one issued, once, the first time it is opened", async () => {
      await seed();
      await withTenant(orgId, (tx) => tx.execute(sql`SELECT 1`));
      // Simulate a legacy payment: remove the receipt using the superuser connection.
      const { adminDb } = await import("../../helpers/db");
      await adminDb().execute(sql`DELETE FROM customer_payment_receipts`);
      const first = await ReceiptService.getForPayment(owner, paymentId);
      const second = await ReceiptService.getForPayment(owner, paymentId);
      expect(first.receiptNumber).toBe("RCT-000001");
      expect(second.id).toBe(first.id);
    });

    it("needs customer_payment:read, and is invisible to another organization", async () => {
      await seed();
      await expect(ReceiptService.getForPayment(actorWithRole(owner, "EMPLOYEE"), paymentId)).rejects.toBeInstanceOf(PermissionDeniedError);
      const other = await createTestOrg("other-org");
      await expect(ReceiptService.getForPayment(other.owner, paymentId)).rejects.toThrow(/not found/);
    });
  });

  describe("customer statements", () => {
    it("lists documents with a running balance to the hand-worked closing balance of 40.00, reconciled", async () => {
      await seed();
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", "2026-02-28");
      expect(s.openingBalance).toBe("0.0000");
      expect(s.lines.map((l) => [l.date, l.type, l.number, l.charge, l.credit, l.balance])).toEqual([
        ["2026-01-05", "INVOICE", "INV-000001", "1100.0000", "0.0000", "1100.0000"],
        ["2026-02-10", "INVOICE", "INV-000002", "550.0000", "0.0000", "1650.0000"],
        ["2026-02-15", "CREDIT_NOTE", "CN-000001", "0.0000", "110.0000", "1540.0000"],
        ["2026-02-20", "PAYMENT", "BANK-REF-1", "0.0000", "1500.0000", "40.0000"],
      ]);
      expect(s.totalCharges).toBe("1650.0000");
      expect(s.totalCredits).toBe("1610.0000");
      expect(s.closingBalance).toBe("40.0000");

      // Aged summary built independently from allocations: INV-2 550 (not yet due) less unapplied 110 + 400 = 40.
      expect(s.aging.buckets).toEqual({ current: "550.0000", days1to30: "0.0000", days31to60: "0.0000", days61to90: "0.0000", days90plus: "0.0000" });
      expect(s.aging.openInvoicesTotal).toBe("550.0000");
      expect(s.aging.unappliedCreditsTotal).toBe("510.0000");
      expect(s.aging.total).toBe("40.0000");
      expect(s.reconciliation).toEqual({ closingBalance: "40.0000", agedTotal: "40.0000", variance: "0.0000", reconciled: true });
    });

    it("an earlier range carries the right opening balance", async () => {
      await seed();
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-02-10", "2026-02-28");
      expect(s.openingBalance).toBe("1100.0000");
      expect(s.lines).toHaveLength(3);
      expect(s.closingBalance).toBe("40.0000");
    });

    it("ages open invoices by days past due as at the end date", async () => {
      await seed();
      // As at 2026-04-30 INV-2 (due 03-12) is 49 days overdue -> 31-60 bucket.
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-04-01", "2026-04-30");
      expect(s.openingBalance).toBe("40.0000");
      expect(s.aging.openInvoices.map((i) => [i.invoiceNumber, i.daysPastDue, i.bucket])).toEqual([["INV-000002", 49, "days31to60"]]);
      expect(s.aging.buckets.days31to60).toBe("550.0000");
    });

    it("a statement as at a past date is NOT changed by credit applied later (history is stable)", async () => {
      await seed();
      const before = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", "2026-02-28");
      await CustomerCreditService.applyToInvoice(owner, creditId, inv2, "110.00", new Date("2026-03-01"));
      await PaymentAllocationService.applyToInvoice(owner, paymentId, inv2, "400.00", new Date("2026-03-05"));
      const after = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", "2026-02-28");
      expect(after).toEqual(before);

      const march = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-03-01", "2026-03-31");
      expect(march.lines).toHaveLength(0);
      expect(march.openingBalance).toBe("40.0000");
      expect(march.closingBalance).toBe("40.0000");
      expect(march.aging.openInvoicesTotal).toBe("40.0000"); // 550 - 110 - 400
      expect(march.aging.unappliedCreditsTotal).toBe("0.0000");
      expect(march.reconciliation.reconciled).toBe(true);
    });

    it("agrees with the live Aged Receivables report (outstanding per customer)", async () => {
      await seed();
      const asAt = new Date("2026-04-30T00:00:00.000Z");
      const aged = await AgedReceivablesService.get(owner, asAt);
      const row = aged.find((r) => r.customerContactId === fx.customerContactId)!;
      // Aged receivables reports gross open invoices; the statement nets unapplied credit against them.
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-04-01", "2026-04-30");
      expect(s.aging.openInvoicesTotal).toBe(row.totalOutstanding);
      expect(s.aging.total).toBe("40.0000");
    });

    it("shows a voided invoice and its void as two lines that net to nothing", async () => {
      const id = await postInvoice("2026-01-10", "2026-02-10", "300.00"); // 330.00
      await InvoiceService.voidInvoice(owner, id, "Raised in error");
      const today = new Date().toISOString().slice(0, 10);
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", today);
      expect(s.lines.map((l) => [l.type, l.balance])).toEqual([
        ["INVOICE", "330.0000"],
        ["INVOICE_VOID", "0.0000"],
      ]);
      expect(s.closingBalance).toBe("0.0000");
      expect(s.aging.openInvoicesTotal).toBe("0.0000");
      expect(s.reconciliation.reconciled).toBe(true);
    });

    it("a voided credit note is reversed on the statement too", async () => {
      const credit = await CustomerCreditService.create(owner, {
        customerContactId: fx.customerContactId,
        issueDate: new Date("2026-01-10"),
        currency,
        arAccountId: fx.arAccountId,
        lines: [{ description: "x", quantity: "1", unitPrice: "100.00", accountId: fx.revenueAccountId }],
      });
      await CustomerCreditService.approveAndPost(owner, credit.id);
      await CustomerCreditService.voidCredit(owner, credit.id, "wrong customer");
      const today = new Date().toISOString().slice(0, 10);
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", today);
      expect(s.lines.map((l) => [l.type, l.balance])).toEqual([
        ["CREDIT_NOTE", "-100.0000"],
        ["CREDIT_NOTE_VOID", "0.0000"],
      ]);
      expect(s.reconciliation.reconciled).toBe(true);
    });

    it("rejects an invalid or reversed range, a non-customer, and a role without the read permissions", async () => {
      await seed();
      await expect(CustomerStatementService.generate(owner, fx.customerContactId, "2026-03-01", "2026-02-01")).rejects.toThrow(/must not be after/);
      await expect(CustomerStatementService.generate(owner, fx.customerContactId, "2026-02-30", "2026-03-01")).rejects.toThrow(/not a real date/);
      await expect(CustomerStatementService.generate(owner, fx.customerContactId, "20260101", "2026-03-01")).rejects.toThrow(/YYYY-MM-DD/);
      await expect(CustomerStatementService.generate(owner, fx.customerContactId, "2000-01-01", "2026-03-01")).rejects.toThrow(/five years/);
      const supplier = await ContactService.create(owner, { kind: "SUPPLIER", displayName: "Sup Ltd", currency });
      await expect(CustomerStatementService.generate(owner, supplier.id, "2026-01-01", "2026-03-01")).rejects.toThrow(/not an active customer/);
      await expect(
        CustomerStatementService.generate(actorWithRole(owner, "EMPLOYEE"), fx.customerContactId, "2026-01-01", "2026-03-01"),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("is invisible to another organization", async () => {
      await seed();
      const other = await createTestOrg("stmt-other");
      await expect(CustomerStatementService.generate(other.owner, fx.customerContactId, "2026-01-01", "2026-03-01")).rejects.toThrow(/not an active customer/);
    });

    it("exports CSV with the exact amounts and neutralises formula-looking text", async () => {
      await seed();
      const s = await CustomerStatementService.generate(owner, fx.customerContactId, "2026-01-01", "2026-02-28");
      const csv = statementToCsv({ ...s, lines: s.lines.map((l, i) => (i === 0 ? { ...l, description: "=HYPERLINK(\"x\")" } : l)) });
      expect(csv).toContain("Opening balance");
      expect(csv).toContain("2026-02-20,payment,BANK-REF-1,Payment received (bank transfer),0.0000,1500.0000,40.0000");
      expect(csv).toContain("Closing balance");
      expect(csv).toContain("'=HYPERLINK");
      expect(csv).not.toContain(",=HYPERLINK");
      expect(csv).toContain("Reconciled");
    });
  });

  describe("AR control account reconciliation", () => {
    it("ledger AR equals the sub-ledger (invoices - credits - payments) with zero variance", async () => {
      await seed();
      const r = await ArControlReconciliationService.get(owner, "2026-03-31");
      expect(r.subledger).toEqual({ invoices: "1650.0000", creditNotes: "110.0000", payments: "1500.0000", total: "40.0000" });
      expect(r.ledger.total).toBe("40.0000");
      expect(r.variance).toBe("0.0000");
      expect(r.reconciled).toBe(true);
    });

    it("a manual journal straight to AR shows as a variance - reported, not plugged", async () => {
      await seed();
      await PostingService.postJournal(owner, {
        postingDate: new Date("2026-03-10"),
        memo: "Manual AR adjustment",
        lines: [
          { accountId: fx.arAccountId, debit: "5.00", currency },
          { accountId: fx.revenueAccountId, credit: "5.00", currency },
        ],
      });
      const r = await ArControlReconciliationService.get(owner, "2026-03-31");
      expect(r.ledger.total).toBe("45.0000");
      expect(r.subledger.total).toBe("40.0000");
      expect(r.variance).toBe("5.0000");
      expect(r.reconciled).toBe(false);
      // As at a date before the manual journal it still reconciles.
      expect((await ArControlReconciliationService.get(owner, "2026-03-09")).reconciled).toBe(true);
    });
  });
});
