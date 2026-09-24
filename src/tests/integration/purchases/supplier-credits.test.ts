import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { SupplierPaymentAllocationService } from "@/domain/purchases/supplier-payment-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Supplier credit notes — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("supplier-credit-flow");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createPostedBill(total = "1100.00") {
    const created = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "Materials", quantity: "10", unitPrice: "100.00", accountId: fixtures.expenseAccountId, taxCodeId: fixtures.taxCodeId }],
    });
    return BillService.approveAndPost(owner, created.id);
  }

  async function createDraftCredit(total = "220.00") {
    return SupplierCreditService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-10"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "Returned goods", quantity: "2", unitPrice: "100.00", accountId: fixtures.expenseAccountId, taxCodeId: fixtures.taxCodeId }],
    });
  }

  it("posts a draft credit note as the mirror of a bill: credits expense/tax, debits AP", async () => {
    const created = await createDraftCredit();
    const posted = await SupplierCreditService.approveAndPost(owner, created.id);
    expect(posted.status).toBe("APPROVED");

    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    const apLine = entry!.lines.find((l) => l.accountId === fixtures.apAccountId);
    const expenseLine = entry!.lines.find((l) => l.accountId === fixtures.expenseAccountId);
    expect(apLine!.debit).toBe("220.0000");
    expect(expenseLine!.credit).toBe("200.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("-220.0000");
  });

  it("applies a posted credit note against an outstanding bill, reducing its balance and eventually paying it off", async () => {
    const bill = await createPostedBill();
    const credit = await createDraftCredit();
    await SupplierCreditService.approveAndPost(owner, credit.id);

    await SupplierCreditService.applyToBill(owner, credit.id, bill.id, "220.00");

    const updatedBill = await BillService.get(owner, bill.id);
    expect(updatedBill!.status).toBe("PART_PAID");
    expect(updatedBill!.amountPaid).toBe("220.0000");

    const updatedCredit = await SupplierCreditService.get(owner, credit.id);
    expect(updatedCredit!.status).toBe("APPLIED");
    expect(updatedCredit!.amountApplied).toBe("220.0000");

    // The remaining 880 can still be settled with a normal cash payment —
    // proving the combined (credit + cash) allocation total is what governs
    // the bill's outstanding balance, not payments alone.
    await SupplierPaymentAllocationService.recordPayment(owner, {
      supplierContactId: fixtures.supplierContactId,
      paymentDate: new Date("2026-01-20"),
      amount: "880.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      paymentAccountId: fixtures.bankGlAccountId,
      allocations: [{ billId: bill.id, amount: "880.00" }],
    });

    const finalBill = await BillService.get(owner, bill.id);
    expect(finalBill!.status).toBe("PAID");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("0.0000");
  });

  it("refuses to apply more of a credit note than remains available on it", async () => {
    const bill = await createPostedBill();
    const credit = await createDraftCredit();
    await SupplierCreditService.approveAndPost(owner, credit.id);

    await expect(SupplierCreditService.applyToBill(owner, credit.id, bill.id, "500.00")).rejects.toThrow(/only 220/);
  });

  it("refuses to apply a credit note that hasn't been posted yet", async () => {
    const bill = await createPostedBill();
    const credit = await createDraftCredit();
    await expect(SupplierCreditService.applyToBill(owner, credit.id, bill.id, "100.00")).rejects.toThrow();
  });

  it("refuses to void a credit note that's been applied", async () => {
    const bill = await createPostedBill();
    const credit = await createDraftCredit();
    await SupplierCreditService.approveAndPost(owner, credit.id);
    await SupplierCreditService.applyToBill(owner, credit.id, bill.id, "100.00");

    await expect(SupplierCreditService.voidCredit(owner, credit.id, "test")).rejects.toThrow(/applied/);
  });

  it("voids a posted, unapplied credit note by reversing its journal", async () => {
    const credit = await createDraftCredit();
    const posted = await SupplierCreditService.approveAndPost(owner, credit.id);
    const voided = await SupplierCreditService.voidCredit(owner, credit.id, "Issued in error");
    expect(voided!.status).toBe("VOID");

    const originalEntry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(originalEntry!.status).toBe("REVERSED");
  });
});
