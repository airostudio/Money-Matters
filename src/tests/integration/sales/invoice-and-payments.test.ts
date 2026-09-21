import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Invoicing & AR core — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("sales-flow");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  async function createDraftInvoice() {
    return InvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [
        {
          description: "Consulting services",
          quantity: "10",
          unitPrice: "100.00",
          accountId: fixtures.revenueAccountId,
          taxCodeId: fixtures.taxCodeId,
        },
      ],
    });
  }

  it("creates a draft invoice with correct computed totals and no ledger effect", async () => {
    const created = await createDraftInvoice();
    const invoice = await InvoiceService.get(owner, created.id);

    expect(invoice!.status).toBe("DRAFT");
    expect(invoice!.subtotal).toBe("1000.0000");
    expect(invoice!.taxTotal).toBe("100.0000");
    expect(invoice!.total).toBe("1100.0000");
    expect(invoice!.journalEntryId).toBeNull();

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    expect(ar!.balance).toBe("0.0000");
  });

  it("approving and posting an invoice debits AR and credits revenue+tax, balanced, and hits the trial balance", async () => {
    const created = await createDraftInvoice();
    const posted = await InvoiceService.approveAndPost(owner, created.id);
    expect(posted.status).toBe("APPROVED");
    expect(posted.journalEntryId).toBeTruthy();

    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(entry!.status).toBe("POSTED");
    const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    expect(totalDebit).toBeCloseTo(1100, 6);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    const revenue = trialBalance.find((r) => r.accountId === fixtures.revenueAccountId);
    const taxPayable = trialBalance.find((r) => r.accountId === fixtures.taxPayableAccountId);
    expect(ar!.balance).toBe("1100.0000");
    expect(revenue!.balance).toBe("1000.0000");
    expect(taxPayable!.balance).toBe("100.0000");
  });

  it("rejects posting a draft invoice twice", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, created.id);
    await expect(InvoiceService.approveAndPost(owner, created.id)).rejects.toThrow();
  });

  it("records a full payment, allocates it, and marks the invoice PAID", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, created.id);

    const payment = await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fixtures.customerContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: created.id, amount: "1100.00" }],
    });
    expect(payment.journalEntryId).toBeTruthy();

    const invoice = await InvoiceService.get(owner, created.id);
    expect(invoice!.status).toBe("PAID");
    expect(invoice!.amountPaid).toBe("1100.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    const bank = trialBalance.find((r) => r.accountId === fixtures.bankGlAccountId);
    expect(ar!.balance).toBe("0.0000");
    expect(bank!.balance).toBe("1100.0000");
  });

  it("records a partial payment and marks the invoice PART_PAID, then finishes it off", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, created.id);

    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fixtures.customerContactId,
      paymentDate: new Date("2026-01-10"),
      amount: "400.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: created.id, amount: "400.00" }],
    });

    let invoice = await InvoiceService.get(owner, created.id);
    expect(invoice!.status).toBe("PART_PAID");
    expect(invoice!.amountPaid).toBe("400.0000");

    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fixtures.customerContactId,
      paymentDate: new Date("2026-01-20"),
      amount: "700.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: created.id, amount: "700.00" }],
    });

    invoice = await InvoiceService.get(owner, created.id);
    expect(invoice!.status).toBe("PAID");
    expect(invoice!.amountPaid).toBe("1100.0000");
  });

  it("rejects an allocation that exceeds the invoice's outstanding balance", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, created.id);

    await expect(
      PaymentAllocationService.recordPayment(owner, {
        customerContactId: fixtures.customerContactId,
        paymentDate: new Date("2026-01-10"),
        amount: "2000.00",
        currency: "AUD",
        method: "BANK_TRANSFER",
        depositAccountId: fixtures.bankGlAccountId,
        allocations: [{ invoiceId: created.id, amount: "2000.00" }],
      }),
    ).rejects.toThrow(/outstanding/);
  });

  it("rejects allocations that sum to more than the payment's own amount", async () => {
    const first = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, first.id);
    const second = await InvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [{ description: "Extra", quantity: "1", unitPrice: "500.00", accountId: fixtures.revenueAccountId }],
    });
    await InvoiceService.approveAndPost(owner, second.id);

    await expect(
      PaymentAllocationService.recordPayment(owner, {
        customerContactId: fixtures.customerContactId,
        paymentDate: new Date("2026-01-10"),
        amount: "600.00",
        currency: "AUD",
        method: "BANK_TRANSFER",
        depositAccountId: fixtures.bankGlAccountId,
        allocations: [
          { invoiceId: first.id, amount: "500.00" },
          { invoiceId: second.id, amount: "500.00" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("allocates a single payment across two invoices for the same customer", async () => {
    const first = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, first.id);
    const second = await InvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [{ description: "Extra", quantity: "1", unitPrice: "500.00", accountId: fixtures.revenueAccountId }],
    });
    await InvoiceService.approveAndPost(owner, second.id);

    const payment = await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fixtures.customerContactId,
      paymentDate: new Date("2026-01-10"),
      amount: "1600.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [
        { invoiceId: first.id, amount: "1100.00" },
        { invoiceId: second.id, amount: "500.00" },
      ],
    });
    expect(payment.allocations).toHaveLength(2);

    const firstInvoice = await InvoiceService.get(owner, first.id);
    const secondInvoice = await InvoiceService.get(owner, second.id);
    expect(firstInvoice!.status).toBe("PAID");
    expect(secondInvoice!.status).toBe("PAID");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    expect(ar!.balance).toBe("0.0000");
  });

  it("voids a posted, unpaid invoice by reversing its journal — never editing the original", async () => {
    const created = await createDraftInvoice();
    const posted = await InvoiceService.approveAndPost(owner, created.id);

    const voided = await InvoiceService.voidInvoice(owner, created.id, "Customer cancelled the engagement");
    expect(voided!.status).toBe("VOID");
    expect(voided!.voidJournalEntryId).toBeTruthy();

    const originalEntry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(originalEntry!.status).toBe("REVERSED");
    // The original entry's lines are untouched — same amounts as when first posted.
    const originalDebit = originalEntry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    expect(originalDebit).toBeCloseTo(1100, 6);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    expect(ar!.balance).toBe("0.0000");
  });

  it("refuses to void an invoice that still has a payment allocated", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, created.id);
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: fixtures.customerContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: created.id, amount: "1100.00" }],
    });

    await expect(InvoiceService.voidInvoice(owner, created.id, "test")).rejects.toThrow(/payments allocated/);
  });

  it("deletes a draft invoice outright, but refuses once it's posted", async () => {
    const created = await createDraftInvoice();
    await InvoiceService.deleteDraft(owner, created.id);
    expect(await InvoiceService.get(owner, created.id)).toBeNull();

    const posted = await createDraftInvoice();
    await InvoiceService.approveAndPost(owner, posted.id);
    await expect(InvoiceService.deleteDraft(owner, posted.id)).rejects.toThrow();
  });

  it("rejects posting an invoice line whose tax code has no payable account configured", async () => {
    const untaxedTaxCode = await import("@/domain/tax/tax-code-service").then((m) =>
      m.TaxCodeService.create(owner, {
        code: "MISCONFIGURED",
        name: "Misconfigured tax code",
        rate: "0.1000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
      }),
    );

    const created = await InvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [
        {
          description: "Bad tax code",
          quantity: "1",
          unitPrice: "100.00",
          accountId: fixtures.revenueAccountId,
          taxCodeId: untaxedTaxCode.id,
        },
      ],
    });

    await expect(InvoiceService.approveAndPost(owner, created.id)).rejects.toThrow(/payable/);
  });
});
