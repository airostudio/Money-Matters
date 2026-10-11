import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createInventoryFixtures } from "../../helpers/inventory";
import { withTenant } from "@/db/tenant";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { CustomerCreditService } from "@/domain/sales/customer-credit-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

/**
 * Customer credit notes - every number is worked out by hand.
 *
 * INV-000001: 10 x 100.00 + 10% GST = 1000.00 + 100.00 = 1100.00
 * CN-000001 : 2  x 100.00 + 10% GST =  200.00 +  20.00 =  220.00
 *
 * After both are posted: AR 1100 - 220 = 880 ; revenue 1000 - 200 = 800 ; GST payable 100 - 20 = 80.
 */
describe("Customer credit notes (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let currency: string;
  let fx: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("customer-credits");
    owner = org.owner;
    orgId = org.organizationId;
    currency = org.baseCurrency;
    fx = await createSalesFixtures(owner, currency);
  });

  async function postedInvoice(unitPrice = "100.00", quantity = "10", issue = "2026-01-05") {
    const inv = await InvoiceService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date(issue),
      dueDate: new Date("2026-02-04"),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "Consulting", quantity, unitPrice, accountId: fx.revenueAccountId, taxCodeId: fx.taxCodeId }],
    });
    await InvoiceService.approveAndPost(owner, inv.id);
    return inv.id;
  }

  async function draftCredit(opts: { invoiceId?: string; quantity?: string; unitPrice?: string; issue?: string } = {}) {
    return CustomerCreditService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date(opts.issue ?? "2026-01-20"),
      currency,
      arAccountId: fx.arAccountId,
      invoiceId: opts.invoiceId,
      lines: [
        {
          description: "Returned goods",
          quantity: opts.quantity ?? "2",
          unitPrice: opts.unitPrice ?? "100.00",
          accountId: fx.revenueAccountId,
          taxCodeId: fx.taxCodeId,
        },
      ],
    });
  }

  async function balances() {
    const tb = await LedgerService.getTrialBalance(owner);
    const bal = (id: string) => tb.find((r) => r.accountId === id)?.balance;
    return { ar: bal(fx.arAccountId), revenue: bal(fx.revenueAccountId), gst: bal(fx.taxPayableAccountId) };
  }

  it("creates a draft with computed totals, a CN- number of its own, and no ledger effect", async () => {
    const created = await draftCredit();
    expect(created.creditNoteNumber).toBe("CN-000001");
    const credit = await CustomerCreditService.get(owner, created.id);
    expect(credit!.status).toBe("DRAFT");
    expect(credit!.subtotal).toBe("200.0000");
    expect(credit!.taxTotal).toBe("20.0000");
    expect(credit!.total).toBe("220.0000");
    expect(credit!.journalEntryId).toBeNull();
    expect((await balances()).ar).toBe("0.0000");
  });

  it("posting debits revenue and GST payable and credits AR, balanced, to the hand-worked balances", async () => {
    await postedInvoice();
    const created = await draftCredit();
    const posted = await CustomerCreditService.approveAndPost(owner, created.id);
    expect(posted.status).toBe("APPROVED");

    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(entry!.status).toBe("POSTED");
    const debit = entry!.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = entry!.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBeCloseTo(220, 6);
    expect(credit).toBeCloseTo(220, 6);

    expect(await balances()).toEqual({ ar: "880.0000", revenue: "800.0000", gst: "80.0000" });
    await expect(CustomerCreditService.approveAndPost(owner, created.id)).rejects.toThrow(/not a draft/);
  });

  it("is applied to an invoice (reducing outstanding), never over-applied, and statuses follow the allocations", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit({ invoiceId });
    await CustomerCreditService.approveAndPost(owner, created.id);

    // More than the credit holds.
    await expect(CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "220.01")).rejects.toThrow(/only 220.0000/);

    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "100.00");
    let credit = await CustomerCreditService.get(owner, created.id);
    expect(credit!.status).toBe("PART_APPLIED");
    expect(credit!.amountApplied).toBe("100.0000");
    expect(credit!.amountRemaining).toBe("120.0000");
    let invoice = await InvoiceService.get(owner, invoiceId);
    expect(invoice!.amountPaid).toBe("100.0000");
    expect(invoice!.status).toBe("PART_PAID");

    await expect(CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "120.01")).rejects.toThrow(/only 120.0000/);
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "120.00");
    credit = await CustomerCreditService.get(owner, created.id);
    expect(credit!.status).toBe("APPLIED");
    invoice = await InvoiceService.get(owner, invoiceId);
    expect(invoice!.amountPaid).toBe("220.0000");
    expect(invoice!.total).toBe("1100.0000");

    // Applying moves no money in the ledger.
    expect((await balances()).ar).toBe("880.0000");
  });

  it("cannot apply more than the invoice's outstanding balance, or across customers or draft invoices", async () => {
    const smallInvoice = await postedInvoice("10.00", "1"); // 10 + 1 GST = 11.00
    const created = await draftCredit();
    await CustomerCreditService.approveAndPost(owner, created.id);
    await expect(CustomerCreditService.applyToInvoice(owner, created.id, smallInvoice, "11.01")).rejects.toThrow(/outstanding/);

    const draftInvoice = await InvoiceService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date("2026-01-06"),
      dueDate: new Date("2026-02-06"),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "50.00", accountId: fx.revenueAccountId }],
    });
    await expect(CustomerCreditService.applyToInvoice(owner, created.id, draftInvoice.id, "10.00")).rejects.toThrow(/not been posted/);

    const { ContactService } = await import("@/domain/contacts/contact-service");
    const other = await ContactService.create(owner, { kind: "CUSTOMER", displayName: "Other Pty Ltd", currency });
    const otherInv = await InvoiceService.create(owner, {
      customerContactId: other.id,
      issueDate: new Date("2026-01-06"),
      dueDate: new Date("2026-02-06"),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "y", quantity: "1", unitPrice: "50.00", accountId: fx.revenueAccountId }],
    });
    await InvoiceService.approveAndPost(owner, otherInv.id);
    await expect(CustomerCreditService.applyToInvoice(owner, created.id, otherInv.id, "10.00")).rejects.toThrow(/different customers/);
  });

  it("un-apply appends a negative row (append-only), restores both balances, and cannot be repeated", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit({ invoiceId });
    await CustomerCreditService.approveAndPost(owner, created.id);
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "220.00");

    let credit = await CustomerCreditService.get(owner, created.id);
    const original = credit!.allocations[0]!;
    expect(original.reversible).toBe(true);

    await CustomerCreditService.unapply(owner, original.id, "Applied to the wrong invoice");
    credit = await CustomerCreditService.get(owner, created.id);
    expect(credit!.status).toBe("APPROVED");
    expect(credit!.amountApplied).toBe("0.0000");
    expect(credit!.allocations).toHaveLength(2);
    expect(credit!.allocations.map((a) => a.amount).sort()).toEqual(["-220.0000", "220.0000"]);
    expect(credit!.allocations.every((a) => !a.reversible)).toBe(true);
    const invoice = await InvoiceService.get(owner, invoiceId);
    expect(invoice!.amountPaid).toBe("0.0000");
    expect(invoice!.status).toBe("APPROVED");

    await expect(CustomerCreditService.unapply(owner, original.id, "again")).rejects.toThrow(/already been reversed/);
    // The reversal row itself cannot be reversed either.
    const reversal = credit!.allocations.find((a) => a.amount.startsWith("-"))!;
    await expect(CustomerCreditService.unapply(owner, reversal.id, "x")).rejects.toThrow(/already been reversed/);
  });

  it("the allocation table is append-only at the database: UPDATE and DELETE are refused to the app role", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit({ invoiceId });
    await CustomerCreditService.approveAndPost(owner, created.id);
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "50.00");
    const upd = await pgMessage(withTenant(orgId, (tx) => tx.execute(sql`UPDATE customer_credit_allocations SET amount = '1'`)));
    expect(upd).toMatch(/permission denied/);
    const del = await pgMessage(withTenant(orgId, (tx) => tx.execute(sql`DELETE FROM customer_credit_allocations`)));
    expect(del).toMatch(/permission denied/);
  });

  it("voiding is refused while applied, then reverses the journal exactly, and statuses end VOID", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit({ invoiceId });
    await CustomerCreditService.approveAndPost(owner, created.id);
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "220.00");
    await expect(CustomerCreditService.voidCredit(owner, created.id, "mistake")).rejects.toThrow(/un-apply/);

    const credit = await CustomerCreditService.get(owner, created.id);
    await CustomerCreditService.unapply(owner, credit!.allocations[0]!.id, "undo");
    const voided = await CustomerCreditService.voidCredit(owner, created.id, "mistake");
    expect(voided!.status).toBe("VOID");
    expect(voided!.voidJournalEntryId).toBeTruthy();
    expect(await balances()).toEqual({ ar: "1100.0000", revenue: "1000.0000", gst: "100.0000" });
    await expect(CustomerCreditService.voidCredit(owner, created.id, "again")).rejects.toThrow(/already void/);
    await expect(CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "1.00")).rejects.toThrow(/not been posted/);
  });

  it("a voided invoice cannot be voided while a credit note is applied to it", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit({ invoiceId });
    await CustomerCreditService.approveAndPost(owner, created.id);
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "10.00");
    await expect(InvoiceService.voidInvoice(owner, invoiceId, "oops")).rejects.toThrow(/payments allocated/);
  });

  it("credits linked to an invoice never exceed it in total", async () => {
    const invoiceId = await postedInvoice(); // 1100.00
    const first = await draftCredit({ invoiceId, quantity: "9", unitPrice: "100.00" }); // 990.00
    await CustomerCreditService.approveAndPost(owner, first.id);
    const second = await draftCredit({ invoiceId, quantity: "2", unitPrice: "100.00" }); // 220.00 > 110.00 room
    await expect(CustomerCreditService.approveAndPost(owner, second.id)).rejects.toThrow(/only 110.0000 of the invoice/);
    const third = await draftCredit({ invoiceId, quantity: "1", unitPrice: "100.00" }); // 110.00 fits exactly
    await CustomerCreditService.approveAndPost(owner, third.id);
  });

  it("refuses a tracked-stock product with a clear message and posts nothing", async () => {
    const inv = await createInventoryFixtures(owner, currency);
    await expect(
      CustomerCreditService.create(owner, {
        customerContactId: fx.customerContactId,
        issueDate: new Date("2026-01-20"),
        currency,
        arAccountId: fx.arAccountId,
        lines: [{ description: "Return", quantity: "1", unitPrice: "10.00", productId: inv.productId }],
      }),
    ).rejects.toThrow(/stock-tracked/);
    expect(await CustomerCreditService.list(owner)).toHaveLength(0);
  });

  it("numbers never collide after a draft is deleted", async () => {
    const a = await draftCredit();
    const b = await draftCredit();
    expect([a.creditNoteNumber, b.creditNoteNumber]).toEqual(["CN-000001", "CN-000002"]);
    await CustomerCreditService.deleteDraft(owner, a.id);
    const c = await draftCredit();
    expect(c.creditNoteNumber).toBe("CN-000003");
  });

  it("a posted credit cannot be edited or deleted, a draft can be edited", async () => {
    const created = await draftCredit();
    await CustomerCreditService.update(owner, created.id, {
      customerContactId: fx.customerContactId,
      issueDate: new Date("2026-01-21"),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "Edited", quantity: "1", unitPrice: "50.00", accountId: fx.revenueAccountId }],
    });
    expect((await CustomerCreditService.get(owner, created.id))!.total).toBe("50.0000");
    await CustomerCreditService.approveAndPost(owner, created.id);
    await expect(CustomerCreditService.deleteDraft(owner, created.id)).rejects.toThrow(/not a draft/);
  });

  it("permissions: read-only roles can read but not manage, bookkeepers post but cannot void", async () => {
    const created = await draftCredit();
    const readOnly = actorWithRole(owner, "READ_ONLY");
    await expect(CustomerCreditService.list(readOnly)).resolves.toHaveLength(1);
    await expect(draftCreditAs(readOnly)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(CustomerCreditService.approveAndPost(readOnly, created.id)).rejects.toBeInstanceOf(PermissionDeniedError);

    const bookkeeper = actorWithRole(owner, "BOOKKEEPER");
    await CustomerCreditService.approveAndPost(bookkeeper, created.id);
    await expect(CustomerCreditService.voidCredit(bookkeeper, created.id, "x")).rejects.toBeInstanceOf(PermissionDeniedError);
    const accountant = actorWithRole(owner, "ACCOUNTANT");
    await expect(CustomerCreditService.voidCredit(accountant, created.id, "x")).resolves.toBeDefined();

    const employee = actorWithRole(owner, "EMPLOYEE");
    await expect(CustomerCreditService.list(employee)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  function draftCreditAs(actor: Actor) {
    return CustomerCreditService.create(actor, {
      customerContactId: fx.customerContactId,
      issueDate: new Date("2026-01-20"),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: fx.revenueAccountId }],
    });
  }

  it("an unapplied credit note is reported as customer credit and a payment can still settle the invoice", async () => {
    const invoiceId = await postedInvoice();
    const created = await draftCredit();
    await CustomerCreditService.approveAndPost(owner, created.id);
    // Customer pays the rest: 1100 - 220 credit applied = 880.
    await CustomerCreditService.applyToInvoice(owner, created.id, invoiceId, "220.00");
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fx.customerContactId,
      paymentDate: new Date("2026-02-01"),
      amount: "880.00",
      currency,
      method: "BANK_TRANSFER",
      depositAccountId: fx.bankGlAccountId,
      allocations: [{ invoiceId, amount: "880.00" }],
    });
    const invoice = await InvoiceService.get(owner, invoiceId);
    expect(invoice!.status).toBe("PAID");
    expect(invoice!.amountPaid).toBe("1100.0000");
    // Ledger: AR = 1100 - 220 - 880 = 0.
    expect((await balances()).ar).toBe("0.0000");
  });
});
