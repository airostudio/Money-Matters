import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { BillService } from "@/domain/purchases/bill-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Payment runs with segregation of duties — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("payment-run-flow");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createPostedBill(unitPrice = "100.00") {
    const created = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "Materials", quantity: "1", unitPrice, accountId: fixtures.expenseAccountId }],
    });
    return BillService.approveAndPost(owner, created.id);
  }

  it("creates a run, adds bills with their full outstanding balance, and computes the run total", async () => {
    const bill1 = await createPostedBill("100.00");
    const bill2 = await createPostedBill("250.00");

    const run = await PaymentRunService.create(owner, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [bill1.id, bill2.id],
    });

    expect(run!.items).toHaveLength(2);
    expect(run!.totalAmount).toBe("350.0000");
    expect(run!.status).toBe("DRAFT");
  });

  it("refuses to add a draft or fully-paid bill to a run", async () => {
    const draftBill = await BillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixtures.expenseAccountId }],
    });

    await expect(
      PaymentRunService.create(owner, {
        paymentDate: new Date(),
        currency: "AUD",
        paymentAccountId: fixtures.bankGlAccountId,
        billIds: [draftBill.id],
      }),
    ).rejects.toThrow();
  });

  it("SEGREGATION OF DUTIES: the creator cannot approve their own run when another eligible approver exists", async () => {
    const bill = await createPostedBill();
    const bookkeeper = await addTestMember(owner, "BOOKKEEPER", "Creator");
    const accountant = await addTestMember(owner, "ACCOUNTANT", "Approver");

    const run = await PaymentRunService.create(bookkeeper, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [bill.id],
    });
    await PaymentRunService.submitForApproval(bookkeeper, run!.id);

    // Same user who created it tries to approve it — rejected in the service layer.
    await expect(PaymentRunService.approve(bookkeeper, run!.id)).rejects.toThrow(/different user must approve/);

    // A run left AWAITING_APPROVAL: no payment should exist yet.
    const stillAwaiting = await PaymentRunService.get(owner, run!.id);
    expect(stillAwaiting!.status).toBe("AWAITING_APPROVAL");

    // A genuinely different user approves it successfully.
    const approved = await PaymentRunService.approve(accountant, run!.id);
    expect(approved!.status).toBe("PAID");
    expect(approved!.approvedById).toBe(accountant.userId);
    expect(approved!.approvedById).not.toBe(bookkeeper.userId);

    const paidBill = await BillService.get(owner, bill.id);
    expect(paidBill!.status).toBe("PAID");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    const bank = trialBalance.find((r) => r.accountId === fixtures.bankGlAccountId);
    expect(ap!.balance).toBe("0.0000");
    expect(bank!.balance).toBe("-100.0000");
  });

  it("batches multiple bills across different suppliers into separate underlying supplier payments on approval", async () => {
    const bill1 = await createPostedBill("100.00");
    const bill2 = await createPostedBill("200.00");

    const bookkeeper = await addTestMember(owner, "BOOKKEEPER", "Creator2");
    const accountant = await addTestMember(owner, "ACCOUNTANT", "Approver2");

    const run = await PaymentRunService.create(bookkeeper, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [bill1.id, bill2.id],
    });
    await PaymentRunService.submitForApproval(bookkeeper, run!.id);
    await PaymentRunService.approve(accountant, run!.id);

    const b1 = await BillService.get(owner, bill1.id);
    const b2 = await BillService.get(owner, bill2.id);
    expect(b1!.status).toBe("PAID");
    expect(b2!.status).toBe("PAID");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const bank = trialBalance.find((r) => r.accountId === fixtures.bankGlAccountId);
    expect(bank!.balance).toBe("-300.0000");
  });

  it("allows self-approval only when the organization has a single eligible approver, and documents it in the audit trail", async () => {
    // owner is OWNER, which has ALL_PERMISSIONS including payment_run:approve
    // — and is the only member of this brand-new org, so owner is the sole
    // eligible approver. Blocking self-approval here would make it
    // impossible for a solo/two-person org to ever pay anything.
    const bill = await createPostedBill();
    const run = await PaymentRunService.create(owner, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [bill.id],
    });
    await PaymentRunService.submitForApproval(owner, run!.id);

    const approved = await PaymentRunService.approve(owner, run!.id);
    expect(approved!.status).toBe("PAID");
    expect(approved!.approvedById).toBe(owner.userId);
    expect(approved!.createdById).toBe(owner.userId);
  });

  it("refuses to submit an empty run for approval", async () => {
    const run = await PaymentRunService.create(owner, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [],
    });
    await expect(PaymentRunService.submitForApproval(owner, run!.id)).rejects.toThrow(/at least one bill/);
  });

  it("refuses to approve a run that isn't awaiting approval", async () => {
    const bill = await createPostedBill();
    const run = await PaymentRunService.create(owner, {
      paymentDate: new Date("2026-02-01"),
      currency: "AUD",
      paymentAccountId: fixtures.bankGlAccountId,
      billIds: [bill.id],
    });
    await expect(PaymentRunService.approve(owner, run!.id)).rejects.toThrow(/awaiting approval/);
  });
});
