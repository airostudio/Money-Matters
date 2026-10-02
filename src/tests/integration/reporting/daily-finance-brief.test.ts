import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { DailyFinanceBriefService } from "@/domain/reporting/daily-finance-brief-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Master spec §73's Daily Finance Brief against real seeded data: overdue
 * receivables, a bill due soon, and a payment run awaiting approval — every
 * figure checked against a direct query of the same underlying domain
 * services, never a value the brief computed itself from scratch.
 */
describe("DailyFinanceBriefService (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  const asOfDate = new Date("2026-05-15");

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("daily-brief");
    owner = org.owner;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);

    await BankAccountService.create(owner, {
      name: "Everyday Account",
      glAccountId: sales.bankGlAccountId,
      currency: "AUD",
      institutionName: "Test Bank",
    });
  });

  async function postInvoice(amount: string, issueDate: Date, dueDate: Date) {
    const created = await InvoiceService.create(owner, {
      customerContactId: sales.customerContactId,
      issueDate,
      dueDate,
      currency: "AUD",
      arAccountId: sales.arAccountId,
      lines: [{ description: "Work", quantity: "1", unitPrice: amount, accountId: sales.revenueAccountId }],
    });
    return InvoiceService.approveAndPost(owner, created.id);
  }

  async function postBill(amount: string, issueDate: Date, dueDate: Date) {
    const created = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate,
      dueDate,
      currency: "AUD",
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Supplies", quantity: "1", unitPrice: amount, accountId: purchases.expenseAccountId }],
    });
    return BillService.approveAndPost(owner, created.id);
  }

  it("matches direct computation for cash, overdue receivables, upcoming receivables/payables, and payment runs awaiting approval", async () => {
    // Overdue invoice (due well before asOfDate).
    await postInvoice("1200.00", new Date("2026-03-01"), new Date("2026-03-15"));
    // Invoice due within the next 7 days (not yet overdue).
    await postInvoice("400.00", new Date("2026-05-10"), new Date("2026-05-20"));
    // Invoice due far in the future — must NOT count toward "next 7 days".
    await postInvoice("900.00", new Date("2026-05-10"), new Date("2026-06-20"));

    // Overdue bill.
    await postBill("300.00", new Date("2026-03-01"), new Date("2026-03-20"));
    // Bill due within the next 7 days.
    await postBill("150.00", new Date("2026-05-10"), new Date("2026-05-18"));

    // A fully-funded cash deposit so the bank account's GL balance is well-defined.
    const { PostingService } = await import("@/domain/ledger/posting-service");
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-01"),
      lines: [
        { accountId: sales.bankGlAccountId, debit: "10000.00", currency: "AUD" },
        { accountId: sales.revenueAccountId, credit: "10000.00", currency: "AUD" },
      ],
    });

    // A payment run awaiting approval.
    const billForRun = await postBill("500.00", new Date("2026-04-01"), new Date("2026-04-30"));
    const run = await PaymentRunService.create(owner, {
      paymentDate: new Date("2026-05-20"),
      currency: "AUD",
      paymentAccountId: sales.bankGlAccountId,
      billIds: [billForRun.id],
    });
    if (!run) throw new Error("expected payment run to be created");
    await PaymentRunService.submitForApproval(owner, run.id);

    const brief = await DailyFinanceBriefService.generate(owner, asOfDate);

    // --- Cash position: must match the real GL balance of the linked account.
    const trialBalance = await LedgerService.getTrialBalance(owner, asOfDate);
    const bankRow = trialBalance.find((r) => r.accountId === sales.bankGlAccountId);
    expect(brief.cash.total).toBe(bankRow!.balance);
    expect(brief.cash.accounts).toHaveLength(1);
    expect(brief.cash.accounts[0]!.balance).toBe(bankRow!.balance);

    // --- Overdue receivables: only the March invoice (1200.00) is overdue as of May 15.
    expect(brief.overdueReceivables.count).toBe(1);
    expect(brief.overdueReceivables.total).toBe("1200.0000");
    expect(brief.overdueReceivables.topPriority[0]!.outstanding).toBe("1200.0000");

    // --- Expected in next 7 days: only the invoice due 2026-05-20 (within 7 days of 2026-05-15).
    expect(brief.next7Days.expectedIn).toBe("400.0000");

    // --- Overdue payables: the March bill (300.00) AND the payment-run bill,
    // which is due 2026-04-30 — also before asOfDate, so also overdue (it's
    // "awaiting approval", not yet paid).
    expect(brief.overduePayables.count).toBe(2);
    expect(brief.overduePayables.total).toBe("800.0000");

    // --- Expected out next 7 days: the bill due 2026-05-18 (150.00) — the payment-run bill (due 2026-04-30) is already overdue, not "next 7 days".
    expect(brief.next7Days.expectedOut).toBe("150.0000");

    // --- Payment runs awaiting approval.
    expect(brief.paymentRunsAwaitingApproval).toHaveLength(1);
    expect(brief.paymentRunsAwaitingApproval[0]!.totalAmount).toBe("500.0000");

    const directRuns = await PaymentRunService.list(owner, { status: "AWAITING_APPROVAL" });
    expect(directRuns).toHaveLength(1);
    expect(brief.paymentRunsAwaitingApproval[0]!.id).toBe(directRuns[0]!.id);

    // --- Callouts: deterministic, derived from the figures above.
    expect(brief.callouts.some((c) => c.includes("overdue"))).toBe(true);
    expect(brief.callouts.some((c) => c.toLowerCase().includes("awaiting your approval"))).toBe(true);

    // No AI key configured in this test environment — the AI summary must be absent, not faked.
    expect(brief.aiSummary).toBeNull();
  });

  it("is refused for a role without financial_report:read, exactly like every other report", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    await expect(DailyFinanceBriefService.generate(employee, asOfDate)).rejects.toThrow(/does not have permission/);
  });

  it("returns an empty-but-valid brief for an organization with no bank accounts, invoices, or bills yet", async () => {
    const org = await createTestOrg("daily-brief-empty");
    const brief = await DailyFinanceBriefService.generate(org.owner, asOfDate);
    expect(brief.cash.accounts).toHaveLength(0);
    expect(brief.cash.total).toBe("0.0000");
    expect(brief.overdueReceivables.count).toBe(0);
    expect(brief.paymentRunsAwaitingApproval).toHaveLength(0);
    expect(brief.callouts).toHaveLength(0);
  });
});
