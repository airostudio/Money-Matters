import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierPaymentAllocationService } from "@/domain/purchases/supplier-payment-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Bills & AP core — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("purchases-flow");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createDraftBill() {
    return BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      supplierReference: "SUP-INV-001",
      lines: [
        {
          description: "Materials",
          quantity: "10",
          unitPrice: "100.00",
          accountId: fixtures.expenseAccountId,
          taxCodeId: fixtures.taxCodeId,
        },
      ],
    });
  }

  it("creates a draft bill with correct computed totals and no ledger effect", async () => {
    const created = await createDraftBill();
    const bill = await BillService.get(owner, created.id);

    expect(bill!.status).toBe("DRAFT");
    expect(bill!.subtotal).toBe("1000.0000");
    expect(bill!.taxTotal).toBe("100.0000");
    expect(bill!.total).toBe("1100.0000");
    expect(bill!.journalEntryId).toBeNull();
    expect(bill!.supplierReference).toBe("SUP-INV-001");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("0.0000");
  });

  it("approving and posting a bill debits expense+tax and credits AP, balanced, and hits the trial balance", async () => {
    const created = await createDraftBill();
    const posted = await BillService.approveAndPost(owner, created.id);
    expect(posted.status).toBe("APPROVED");
    expect(posted.journalEntryId).toBeTruthy();

    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(entry!.status).toBe("POSTED");
    const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    expect(totalDebit).toBeCloseTo(1100, 6);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    const expense = trialBalance.find((r) => r.accountId === fixtures.expenseAccountId);
    const taxReceivable = trialBalance.find((r) => r.accountId === fixtures.taxReceivableAccountId);
    expect(ap!.balance).toBe("1100.0000");
    expect(expense!.balance).toBe("1000.0000");
    expect(taxReceivable!.balance).toBe("100.0000");
  });

  it("rejects posting a draft bill twice", async () => {
    const created = await createDraftBill();
    await BillService.approveAndPost(owner, created.id);
    await expect(BillService.approveAndPost(owner, created.id)).rejects.toThrow();
  });

  it("records a full payment, allocates it, and marks the bill PAID", async () => {
    const created = await createDraftBill();
    await BillService.approveAndPost(owner, created.id);

    const payment = await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [{ billId: created.id, amount: "1100.00" }],
    });
    expect(payment.journalEntryId).toBeTruthy();

    const bill = await BillService.get(owner, created.id);
    expect(bill!.status).toBe("PAID");
    expect(bill!.amountPaid).toBe("1100.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    const bank = trialBalance.find((r) => r.accountId === fixtures.bankGlAccountId);
    expect(ap!.balance).toBe("0.0000");
    expect(bank!.balance).toBe("-1100.0000");
  });

  it("records a partial payment and marks the bill PART_PAID, then finishes it off", async () => {
    const created = await createDraftBill();
    await BillService.approveAndPost(owner, created.id);

    await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-10"),
      amount: "400.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [{ billId: created.id, amount: "400.00" }],
    });

    let bill = await BillService.get(owner, created.id);
    expect(bill!.status).toBe("PART_PAID");
    expect(bill!.amountPaid).toBe("400.0000");

    await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-20"),
      amount: "700.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [{ billId: created.id, amount: "700.00" }],
    });

    bill = await BillService.get(owner, created.id);
    expect(bill!.status).toBe("PAID");
    expect(bill!.amountPaid).toBe("1100.0000");
  });

  it("rejects an allocation that exceeds the bill's outstanding balance", async () => {
    const created = await createDraftBill();
    await BillService.approveAndPost(owner, created.id);

    await expect(
      SupplierPaymentAllocationService.recordPayment(owner, {
        supplierContactId: fixtures.supplierContactId,
        paymentDate: new Date("2026-01-10"),
        amount: "2000.00",
        currency: "AUD",
        method: "BANK_TRANSFER",
        paymentAccountId: fixtures.bankGlAccountId,
        allocations: [{ billId: created.id, amount: "2000.00" }],
      }),
    ).rejects.toThrow(/outstanding/);
  });

  it("rejects allocations that sum to more than the payment's own amount", async () => {
    const first = await createDraftBill();
    await BillService.approveAndPost(owner, first.id);
    const second = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "Extra", quantity: "1", unitPrice: "500.00", accountId: fixtures.expenseAccountId }],
    });
    await BillService.approveAndPost(owner, second.id);

    await expect(
      SupplierPaymentAllocationService.recordPayment(owner, {
        supplierContactId: fixtures.supplierContactId,
        paymentDate: new Date("2026-01-10"),
        amount: "600.00",
        currency: "AUD",
        method: "BANK_TRANSFER",
        paymentAccountId: fixtures.bankGlAccountId,
        allocations: [
          { billId: first.id, amount: "500.00" },
          { billId: second.id, amount: "500.00" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("allocates a single payment across two bills for the same supplier", async () => {
    const first = await createDraftBill();
    await BillService.approveAndPost(owner, first.id);
    const second = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "Extra", quantity: "1", unitPrice: "500.00", accountId: fixtures.expenseAccountId }],
    });
    await BillService.approveAndPost(owner, second.id);

    const payment = await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-10"),
      amount: "1600.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [
        { billId: first.id, amount: "1100.00" },
        { billId: second.id, amount: "500.00" },
      ],
    });
    expect(payment.allocations).toHaveLength(2);

    const firstBill = await BillService.get(owner, first.id);
    const secondBill = await BillService.get(owner, second.id);
    expect(firstBill!.status).toBe("PAID");
    expect(secondBill!.status).toBe("PAID");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("0.0000");
  });

  it("voids a posted, unpaid bill by reversing its journal — never editing the original", async () => {
    const created = await createDraftBill();
    const posted = await BillService.approveAndPost(owner, created.id);

    const voided = await BillService.voidBill(owner, created.id, "Goods returned to supplier");
    expect(voided!.status).toBe("VOID");
    expect(voided!.voidJournalEntryId).toBeTruthy();

    const originalEntry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(originalEntry!.status).toBe("REVERSED");
    const originalCredit = originalEntry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(originalCredit).toBeCloseTo(1100, 6);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("0.0000");
  });

  it("refuses to void a bill that still has a payment allocated", async () => {
    const created = await createDraftBill();
    await BillService.approveAndPost(owner, created.id);
    await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [{ billId: created.id, amount: "1100.00" }],
    });

    await expect(BillService.voidBill(owner, created.id, "test")).rejects.toThrow(/payments allocated/);
  });

  it("deletes a draft bill outright, but refuses once it's posted", async () => {
    const created = await createDraftBill();
    await BillService.deleteDraft(owner, created.id);
    expect(await BillService.get(owner, created.id)).toBeNull();

    const posted = await createDraftBill();
    await BillService.approveAndPost(owner, posted.id);
    await expect(BillService.deleteDraft(owner, posted.id)).rejects.toThrow();
  });

  it("rejects posting a bill line whose tax code has no receivable account configured", async () => {
    const misconfiguredTaxCode = await import("@/domain/tax/tax-code-service").then((m) =>
      m.TaxCodeService.create(owner, {
        code: "MISCONFIGURED-AP",
        name: "Misconfigured tax code",
        rate: "0.1000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
      }),
    );

    const created = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [
        {
          description: "Bad tax code",
          quantity: "1",
          unitPrice: "100.00",
          accountId: fixtures.expenseAccountId,
          taxCodeId: misconfiguredTaxCode.id,
        },
      ],
    });

    await expect(BillService.approveAndPost(owner, created.id)).rejects.toThrow(/receivable/);
  });
});
