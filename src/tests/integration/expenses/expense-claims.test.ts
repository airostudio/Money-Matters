import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createExpenseFixtures } from "../../helpers/expenses";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Expense claims — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createExpenseFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("expenses-flow");
    owner = org.owner;
    fixtures = await createExpenseFixtures(owner, org.baseCurrency);
  });

  async function createDraftClaim() {
    return ExpenseClaimService.create(owner, {
      employeeUserId: owner.userId,
      claimDate: new Date("2026-02-01"),
      description: "Sydney client trip",
      currency: "AUD",
      payableAccountId: fixtures.payableAccountId,
      lines: [
        {
          description: "Taxi",
          amount: "100.00",
          expenseAccountId: fixtures.expenseAccountId,
          taxCodeId: fixtures.taxCodeId,
          category: "Travel",
        },
      ],
    });
  }

  it("creates a draft claim with correct computed totals and no ledger effect", async () => {
    const created = await createDraftClaim();
    const claim = await ExpenseClaimService.get(owner, created.id);

    expect(claim!.status).toBe("DRAFT");
    expect(claim!.subtotal).toBe("100.0000");
    expect(claim!.taxTotal).toBe("10.0000");
    expect(claim!.total).toBe("110.0000");
    expect(claim!.journalEntryId).toBeNull();

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const payable = trialBalance.find((r) => r.accountId === fixtures.payableAccountId);
    expect(payable!.balance).toBe("0.0000");
  });

  it("submits a draft claim with at least one line", async () => {
    const created = await createDraftClaim();
    const submitted = await ExpenseClaimService.submit(owner, created.id);
    expect(submitted!.status).toBe("SUBMITTED");
  });

  it("refuses to edit or delete once submitted", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);

    await expect(
      ExpenseClaimService.update(owner, created.id, {
        employeeUserId: owner.userId,
        claimDate: new Date(),
        description: "edited",
        currency: "AUD",
        payableAccountId: fixtures.payableAccountId,
        lines: [{ description: "x", amount: "1.00", expenseAccountId: fixtures.expenseAccountId }],
      }),
    ).rejects.toThrow(/not a draft/);

    await expect(ExpenseClaimService.deleteDraft(owner, created.id)).rejects.toThrow(/not a draft/);
  });

  it("approving and posting a submitted claim debits expense+tax and credits the payable, balanced, and hits the trial balance", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    const posted = await ExpenseClaimService.approve(owner, created.id);
    expect(posted.status).toBe("APPROVED");
    expect(posted.journalEntryId).toBeTruthy();

    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(entry!.status).toBe("POSTED");
    const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    expect(totalDebit).toBeCloseTo(110, 6);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const payable = trialBalance.find((r) => r.accountId === fixtures.payableAccountId);
    const expense = trialBalance.find((r) => r.accountId === fixtures.expenseAccountId);
    const taxReceivable = trialBalance.find((r) => r.accountId === fixtures.taxReceivableAccountId);
    expect(payable!.balance).toBe("110.0000");
    expect(expense!.balance).toBe("100.0000");
    expect(taxReceivable!.balance).toBe("10.0000");
  });

  it("rejects approving a draft (not yet submitted) claim", async () => {
    const created = await createDraftClaim();
    await expect(ExpenseClaimService.approve(owner, created.id)).rejects.toThrow(/not been submitted/);
  });

  it("rejects approving a claim twice", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    await ExpenseClaimService.approve(owner, created.id);
    await expect(ExpenseClaimService.approve(owner, created.id)).rejects.toThrow();
  });

  it("rejects a submitted claim with no ledger effect, and can't be approved afterwards", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    const rejected = await ExpenseClaimService.reject(owner, created.id, "Missing receipt");
    expect(rejected!.status).toBe("REJECTED");
    expect(rejected!.rejectionReason).toBe("Missing receipt");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const payable = trialBalance.find((r) => r.accountId === fixtures.payableAccountId);
    expect(payable!.balance).toBe("0.0000");

    await expect(ExpenseClaimService.approve(owner, created.id)).rejects.toThrow(/not been submitted/);
  });

  it("marks an approved claim reimbursed with a second journal, debiting the payable and crediting the bank", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    await ExpenseClaimService.approve(owner, created.id);

    const reimbursed = await ExpenseClaimService.markReimbursed(owner, created.id, {
      reimbursementAccountId: fixtures.bankGlAccountId,
      reimbursementDate: new Date("2026-02-10"),
      reference: "EFT-123",
    });
    expect(reimbursed.status).toBe("REIMBURSED");
    expect(reimbursed.journalEntryId).toBeTruthy();

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const payable = trialBalance.find((r) => r.accountId === fixtures.payableAccountId);
    const bank = trialBalance.find((r) => r.accountId === fixtures.bankGlAccountId);
    expect(payable!.balance).toBe("0.0000");
    expect(bank!.balance).toBe("-110.0000");
  });

  it("refuses to mark reimbursed before approval", async () => {
    const created = await createDraftClaim();
    await expect(
      ExpenseClaimService.markReimbursed(owner, created.id, {
        reimbursementAccountId: fixtures.bankGlAccountId,
        reimbursementDate: new Date(),
      }),
    ).rejects.toThrow(/not approved/);
  });

  it("voids an approved, not-yet-reimbursed claim by reversing its journal — never editing the original", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    const posted = await ExpenseClaimService.approve(owner, created.id);

    const voided = await ExpenseClaimService.voidClaim(owner, created.id, "Claimed in error");
    expect(voided!.status).toBe("VOID");
    expect(voided!.voidJournalEntryId).toBeTruthy();

    const originalEntry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(originalEntry!.status).toBe("REVERSED");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const payable = trialBalance.find((r) => r.accountId === fixtures.payableAccountId);
    expect(payable!.balance).toBe("0.0000");
  });

  it("refuses to void a claim that has already been reimbursed", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.submit(owner, created.id);
    await ExpenseClaimService.approve(owner, created.id);
    await ExpenseClaimService.markReimbursed(owner, created.id, {
      reimbursementAccountId: fixtures.bankGlAccountId,
      reimbursementDate: new Date(),
    });

    await expect(ExpenseClaimService.voidClaim(owner, created.id, "test")).rejects.toThrow(/not approved/);
  });

  it("deletes a draft claim outright, but refuses once submitted", async () => {
    const created = await createDraftClaim();
    await ExpenseClaimService.deleteDraft(owner, created.id);
    expect(await ExpenseClaimService.get(owner, created.id)).toBeNull();

    const submitted = await createDraftClaim();
    await ExpenseClaimService.submit(owner, submitted.id);
    await expect(ExpenseClaimService.deleteDraft(owner, submitted.id)).rejects.toThrow();
  });

  it("rejects posting a claim line whose tax code has no receivable account configured", async () => {
    const misconfiguredTaxCode = await import("@/domain/tax/tax-code-service").then((m) =>
      m.TaxCodeService.create(owner, {
        code: "MISCONFIGURED-EXP",
        name: "Misconfigured tax code",
        rate: "0.1000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
      }),
    );

    const created = await ExpenseClaimService.create(owner, {
      employeeUserId: owner.userId,
      claimDate: new Date("2026-02-01"),
      description: "Bad tax code claim",
      currency: "AUD",
      payableAccountId: fixtures.payableAccountId,
      lines: [
        {
          description: "x",
          amount: "50.00",
          expenseAccountId: fixtures.expenseAccountId,
          taxCodeId: misconfiguredTaxCode.id,
        },
      ],
    });
    await ExpenseClaimService.submit(owner, created.id);

    await expect(ExpenseClaimService.approve(owner, created.id)).rejects.toThrow(/receivable/);
  });

  it("a non-approver (EMPLOYEE) can create and submit their own claim but cannot approve it", async () => {
    const employee: Actor = { ...owner, role: "EMPLOYEE" };
    const created = await ExpenseClaimService.create(employee, {
      employeeUserId: employee.userId,
      claimDate: new Date("2026-02-01"),
      description: "Self-service claim",
      currency: "AUD",
      payableAccountId: fixtures.payableAccountId,
      lines: [{ description: "Parking", amount: "20.00", expenseAccountId: fixtures.expenseAccountId }],
    });
    await ExpenseClaimService.submit(employee, created.id);

    await expect(ExpenseClaimService.approve(employee, created.id)).rejects.toThrow();
  });
});
