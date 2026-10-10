import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { ContactService } from "@/domain/contacts/contact-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { AgedReceivablesService } from "@/domain/sales/aged-receivables-service";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Unit-level tests for each Financial Controller tool wrapper
 * (`controller-tools.ts`): each one must delegate to the exact same
 * domain-service call the equivalent UI page makes, and must refuse (not
 * throw, not 500, not silently return empty data) when the actor's role
 * lacks the underlying permission — master spec §49, the single most
 * safety-critical requirement of this slice.
 */
describe("AI Financial Controller — tool wrappers", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("controller-tools");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  const tools = () => buildControllerTools([]);
  const find = (name: string) => {
    const def = tools().find((t) => t.name === name);
    if (!def) throw new Error(`tool ${name} not registered`);
    return def;
  };

  it("trial_balance delegates to LedgerService.getTrialBalance and reports the same balances", async () => {
    await InvoiceService.approveAndPost(
      owner,
      (
        await InvoiceService.create(owner, {
          customerContactId: fixtures.customerContactId,
          issueDate: new Date("2026-01-05"),
          dueDate: new Date("2026-01-20"),
          currency: "AUD",
          arAccountId: fixtures.arAccountId,
          lines: [{ description: "Work", quantity: "1", unitPrice: "1000.00", accountId: fixtures.revenueAccountId }],
        })
      ).id,
    );

    const outcome = await find("trial_balance").execute(owner, { asOfDate: "2026-01-31" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    const direct = await LedgerService.getTrialBalance(owner, new Date("2026-01-31"));
    const revenueRow = direct.find((r) => r.accountId === fixtures.revenueAccountId);
    expect(revenueRow?.balance).toBe("1000.0000");
    expect(outcome.summary).toContain("1000.0000");
    expect(outcome.citation.drillDownHref).toContain("/accounting/trial-balance");
  });

  it("trial_balance is refused for a role without journal:read, exactly as the UI would refuse it", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    const outcome = await find("trial_balance").execute(employee, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.error).toMatch(/access denied/i);
    expect(outcome.error).toContain("journal:read");
  });

  it("profit_and_loss delegates to ReportingService.getProfitAndLoss for the resolved period", async () => {
    await InvoiceService.approveAndPost(
      owner,
      (
        await InvoiceService.create(owner, {
          customerContactId: fixtures.customerContactId,
          issueDate: new Date("2026-02-05"),
          dueDate: new Date("2026-02-20"),
          currency: "AUD",
          arAccountId: fixtures.arAccountId,
          lines: [{ description: "Work", quantity: "1", unitPrice: "500.00", accountId: fixtures.revenueAccountId }],
        })
      ).id,
    );

    const outcome = await find("profit_and_loss").execute(owner, {
      period: { kind: "CUSTOM", from: "2026-02-01", to: "2026-02-28" },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.summary).toContain("500.0000");

    const direct = await ReportingService.getProfitAndLoss(owner, { from: new Date("2026-02-01"), to: new Date("2026-02-28") });
    expect(outcome.summary).toContain(direct.totalRevenue);
  });

  it("profit_and_loss is refused for a role without financial_report:read", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    const outcome = await find("profit_and_loss").execute(employee, { period: { kind: "THIS_MONTH" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.error).toContain("financial_report:read");
  });

  it("balance_sheet is refused for a role without financial_report:read", async () => {
    const payrollManager = actorWithRole(owner, "PAYROLL_MANAGER");
    const outcome = await find("balance_sheet").execute(payrollManager, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.error).toContain("financial_report:read");
  });

  it("aged_receivables delegates to AgedReceivablesService.getWithPriority and matches its figures exactly", async () => {
    await InvoiceService.approveAndPost(
      owner,
      (
        await InvoiceService.create(owner, {
          customerContactId: fixtures.customerContactId,
          issueDate: new Date("2026-01-01"),
          dueDate: new Date("2026-01-05"),
          currency: "AUD",
          arAccountId: fixtures.arAccountId,
          lines: [{ description: "Work", quantity: "1", unitPrice: "300.00", accountId: fixtures.revenueAccountId }],
        })
      ).id,
    );

    const asOfDate = "2026-02-01";
    const outcome = await find("aged_receivables").execute(owner, { asOfDate });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    const direct = await AgedReceivablesService.getWithPriority(owner, new Date(asOfDate));
    expect(direct).toHaveLength(1);
    expect(outcome.summary).toContain(direct[0]!.outstanding);
    expect(outcome.summary).toContain("Acme Pty Ltd");
  });

  it("aged_receivables is refused for a role without customer_invoice:read", async () => {
    const payrollManager = actorWithRole(owner, "PAYROLL_MANAGER");
    const outcome = await find("aged_receivables").execute(payrollManager, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.error).toContain("customer_invoice:read");
  });

  it("find_invoice matches by invoice number and by customer name, and is refused without customer_invoice:read", async () => {
    const created = await InvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [{ description: "Work", quantity: "1", unitPrice: "42.00", accountId: fixtures.revenueAccountId }],
    });

    const byNumber = await find("find_invoice").execute(owner, { query: created.invoiceNumber });
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok) throw new Error("expected ok");
    expect(byNumber.summary).toContain("42.00");

    const byCustomer = await find("find_invoice").execute(owner, { query: "acme" });
    expect(byCustomer.ok).toBe(true);
    if (!byCustomer.ok) throw new Error("expected ok");
    expect(byCustomer.summary).toContain(created.invoiceNumber);

    const employee = actorWithRole(owner, "EMPLOYEE");
    const refused = await find("find_invoice").execute(employee, { query: "acme" });
    expect(refused.ok).toBe(false);
  });

  it("find_expense_claim restricts a non-approver to their own claims, exactly like the Expenses page — a different employee's claim never leaks through the tool", async () => {
    const { addTestMember } = await import("../../helpers/db");
    const { ExpenseClaimService } = await import("@/domain/expenses/expense-claim-service");
    const { AccountService } = await import("@/domain/accounts/account-service");

    const employeeA = await addTestMember(owner, "EMPLOYEE", "Alice");
    const employeeB = await addTestMember(owner, "EMPLOYEE", "Bob");
    const payableAccount = await AccountService.create(owner, {
      code: "REIMB-01",
      name: "Employee Reimbursements Payable",
      type: "LIABILITY",
      currency: "AUD",
    });

    const claim = await ExpenseClaimService.create(employeeA, {
      employeeUserId: employeeA.userId,
      claimDate: new Date("2026-01-10"),
      description: "January taxi",
      currency: "AUD",
      payableAccountId: payableAccount.id,
      lines: [{ description: "Taxi", amount: "55.00", expenseAccountId: fixtures.revenueAccountId }],
    });

    const ownResult = await find("find_expense_claim").execute(employeeA, { query: claim.claimNumber });
    expect(ownResult.ok).toBe(true);
    if (!ownResult.ok) throw new Error("expected ok");
    expect(ownResult.summary).toContain(claim.claimNumber);

    const othersResult = await find("find_expense_claim").execute(employeeB, { query: claim.claimNumber });
    expect(othersResult.ok).toBe(true);
    if (!othersResult.ok) throw new Error("expected ok");
    expect(othersResult.summary).not.toContain(claim.claimNumber);
    expect(othersResult.summary).toMatch(/no expense claims matched/i);
  });

  it("run_report reuses ReportBuilderService.runConfig and matches a manual report-builder query exactly", async () => {
    await InvoiceService.approveAndPost(
      owner,
      (
        await InvoiceService.create(owner, {
          customerContactId: fixtures.customerContactId,
          issueDate: new Date("2026-03-05"),
          dueDate: new Date("2026-03-20"),
          currency: "AUD",
          arAccountId: fixtures.arAccountId,
          lines: [{ description: "Work", quantity: "1", unitPrice: "777.00", accountId: fixtures.revenueAccountId }],
        })
      ).id,
    );

    const { ReportBuilderService } = await import("@/domain/reporting/report-builder-service");
    const outcome = await find("run_report").execute(owner, {
      metric: "REVENUE",
      period: { kind: "CUSTOM", from: "2026-03-01", to: "2026-03-31" },
      breakdown: "NONE",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    const manual = await ReportBuilderService.runConfig(owner, {
      rowGroupBy: "ACCOUNT_TYPE",
      accountTypes: ["REVENUE"],
      measure: "MOVEMENT",
      periodBreakdown: "NONE",
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    expect(outcome.summary).toContain(manual.rows[0]!.values[0]!);
  });

  it("run_report is refused for a role without financial_report:read", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    const outcome = await find("run_report").execute(employee, {
      metric: "REVENUE",
      period: { kind: "THIS_MONTH" },
      breakdown: "NONE",
    });
    expect(outcome.ok).toBe(false);
  });

  it("never leaks a contact that belongs to a different organization", async () => {
    const otherOrg = await createTestOrg("controller-tools-other");
    const otherFixtures = await createSalesFixtures(otherOrg.owner, otherOrg.baseCurrency);
    const otherContact = await ContactService.get(otherOrg.owner, otherFixtures.customerContactId);
    expect(otherContact).not.toBeNull();

    const outcome = await find("find_invoice").execute(owner, { query: "Acme" });
    // owner's own org has an "Acme Pty Ltd" customer from createSalesFixtures, but zero invoices yet.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.summary).toMatch(/no invoices matched/i);
  });
});
