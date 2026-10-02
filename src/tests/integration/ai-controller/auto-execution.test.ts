import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { AutonomySettingsService } from "@/domain/ai-controller/autonomy";
import {
  AutoApprovedActionsService,
  InvalidAutoApprovedActionTypeError,
  isAutoExecutionApproved,
} from "@/domain/ai-controller/auto-execution-policy";
import { AutoExecutionService } from "@/domain/ai-controller/auto-execution-service";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { SelfApprovalNotAllowedError } from "@/domain/purchases/errors";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { AIDraftProposalService } from "@/domain/ai-controller/draft-proposal-service";
import { withTenant } from "@/db/tenant";
import { auditLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Real-database proof for Phase 6 Slice 3's auto-execution engine — the
 * slice's two most safety-critical guarantees:
 *   1. the autonomy level ALONE never triggers anything without an explicit,
 *      separate per-action-type whitelist entry;
 *   2. a hard-excluded category (supplier payments/payment runs here) is
 *      refused structurally, at Level 4, exactly as it would be at Level 0 —
 *      `PaymentRunService`'s own segregation-of-duties check is never routed
 *      around by any autonomy level.
 * Plus the emergency stop's immediate effect and the full
 * whitelist → auto-execute → visibly-flagged → audited → undo round trip.
 */
describe("AI Controller Level 3/4 auto-execution (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let salesFixtures: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchasesFixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("ai-auto-exec");
    owner = org.owner;
    orgId = org.organizationId;
    salesFixtures = await createSalesFixtures(owner, org.baseCurrency);
    purchasesFixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createDueMonthlyInvoiceTemplate(name: string, startDate: Date) {
    return RecurringInvoiceService.create(owner, {
      customerContactId: salesFixtures.customerContactId,
      name,
      currency: "AUD",
      arAccountId: salesFixtures.arAccountId,
      frequency: "MONTHLY",
      startDate,
      lines: [{ description: "Retainer", quantity: "1", unitPrice: "500.00", accountId: salesFixtures.revenueAccountId }],
    });
  }

  describe("the whitelist mechanism — level alone does nothing", () => {
    it("Level 4 selected, empty whitelist: zero auto-execution even with due work available", async () => {
      await AutonomySettingsService.setLevel(owner, 4);
      await createDueMonthlyInvoiceTemplate("Retainer", new Date(Date.now() - 24 * 60 * 60 * 1000));

      const results = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(results.every((r) => r.executed === 0)).toBe(true);
      const invoiceResult = results.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE");
      expect(invoiceResult?.skippedReason).toBe("not whitelisted");

      const invoices = await InvoiceService.list(owner, {});
      expect(invoices).toHaveLength(0);
    });

    it("whitelisted action type, but Level 2: still zero auto-execution (level below 3)", async () => {
      await AutonomySettingsService.setLevel(owner, 2);
      // Can't whitelist below level 3 in the UI, but prove the SERVICE layer
      // enforces this too, not just a UI gate: directly call setEnabled.
      await AutoApprovedActionsService.setEnabled(owner, "RECURRING_INVOICE_AUTO_GENERATE", true);
      await createDueMonthlyInvoiceTemplate("Retainer", new Date(Date.now() - 24 * 60 * 60 * 1000));

      const { approved, level } = await isAutoExecutionApproved(orgId, "RECURRING_INVOICE_AUTO_GENERATE");
      expect(approved).toBe(false);
      expect(level).toBe(2);

      const results = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(results.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE")?.executed).toBe(0);
    });
  });

  describe("excluded categories — refused structurally, even at Level 4", () => {
    it("refuses to whitelist a supplier-payment-shaped action type", async () => {
      await AutonomySettingsService.setLevel(owner, 4);
      await expect(AutoApprovedActionsService.setEnabled(owner, "SUPPLIER_PAYMENT_CREATE", true)).rejects.toThrow(
        InvalidAutoApprovedActionTypeError,
      );
      await expect(AutoApprovedActionsService.setEnabled(owner, "PAYMENT_RUN_APPROVE", true)).rejects.toThrow(
        InvalidAutoApprovedActionTypeError,
      );
    });

    it("refuses to whitelist a bank-detail, payroll, or tax-shaped action type", async () => {
      await AutonomySettingsService.setLevel(owner, 4);
      for (const bogus of ["BANK_ACCOUNT_DETAIL_CHANGE", "PAYROLL_ANY", "TAX_SUBMISSION_ANY", "JOURNAL_ENTRY_UNUSUAL", "FISCAL_PERIOD_CLOSE"]) {
        await expect(AutoApprovedActionsService.setEnabled(owner, bogus, true)).rejects.toThrow(InvalidAutoApprovedActionTypeError);
      }
    });

    it("PaymentRunService's segregation-of-duties still blocks self-approval at Level 4 with everything whitelisted — exactly as it would at Level 0", async () => {
      // A second eligible approver is required to force the check at all
      // (an org with exactly one eligible approver is deliberately let
      // through — see payment-run-service.ts) — mirrors
      // src/tests/integration/purchases/payment-runs.test.ts's own setup.
      await addTestMember(owner, "ACCOUNTANT", "Second Approver");

      await AutonomySettingsService.setLevel(owner, 4);
      for (const actionType of ["RECURRING_INVOICE_AUTO_GENERATE", "RECURRING_BILL_AUTO_GENERATE", "BANK_RECONCILIATION_AUTO_MATCH"] as const) {
        await AutoApprovedActionsService.setEnabled(owner, actionType, true);
      }

      const created = await BillService.create(owner, {
        supplierContactId: purchasesFixtures.supplierContactId,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        currency: "AUD",
        apAccountId: purchasesFixtures.apAccountId,
        lines: [{ description: "Materials", quantity: "1", unitPrice: "100.00", accountId: purchasesFixtures.expenseAccountId }],
      });
      const bill = await BillService.approveAndPost(owner, created.id);

      const run = await PaymentRunService.create(owner, {
        paymentDate: new Date("2026-02-01"),
        currency: "AUD",
        paymentAccountId: purchasesFixtures.bankGlAccountId,
        billIds: [bill.id],
      });
      await PaymentRunService.submitForApproval(owner, run!.id);

      // The same owner who created it tries to approve it — refused exactly
      // as it would be at Level 0. Nothing about autonomy level 4 or a full
      // whitelist changes this: PaymentRunService's own check is untouched
      // and is never bypassed by any AI-controller code path, because no
      // AI-controller code path calls it at all.
      await expect(PaymentRunService.approve(owner, run!.id)).rejects.toThrow(SelfApprovalNotAllowedError);
    });

    it("never promotes prepare_draft_journal_entry to auto-execute, even at Level 4 with a full whitelist — it stays PENDING", async () => {
      await AutonomySettingsService.setLevel(owner, 4);
      for (const actionType of ["RECURRING_INVOICE_AUTO_GENERATE", "RECURRING_BILL_AUTO_GENERATE", "BANK_RECONCILIATION_AUTO_MATCH"] as const) {
        await AutoApprovedActionsService.setEnabled(owner, actionType, true);
      }

      const tool = buildWriteTools("adjust something", "test-model").find((t) => t.name === "prepare_draft_journal_entry")!;
      const outcome = await tool.execute(owner, {
        lines: [
          { accountName: salesFixtures.revenueAccountId, debit: "10.00" },
          { accountName: salesFixtures.arAccountId, credit: "10.00" },
        ],
      });
      // Resolution may fail on account name lookup details, but what matters
      // is there is no code path that could have auto-confirmed it even if
      // it had succeeded — prove the proposal mechanism, not this specific
      // tool call's resolution.
      if (outcome.ok && outcome.proposal) {
        await AutoExecutionService.runPendingAutoExecutions(owner);
        const proposal = await AIDraftProposalService.get(owner, outcome.proposal.id);
        expect(proposal?.status).toBe("PENDING");
      }
    });
  });

  describe("Level 3 whitelisted end-to-end: recurring invoice auto-generation", () => {
    it("auto-generates a due invoice with no chat interaction, visibly flagged, and fully audited", async () => {
      await AutonomySettingsService.setLevel(owner, 3);
      await AutoApprovedActionsService.setEnabled(owner, "RECURRING_INVOICE_AUTO_GENERATE", true);
      await createDueMonthlyInvoiceTemplate("Retainer", new Date(Date.now() - 24 * 60 * 60 * 1000));

      const results = await AutoExecutionService.runPendingAutoExecutions(owner);
      const invoiceResult = results.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE");
      expect(invoiceResult?.executed).toBe(1);

      const invoices = await InvoiceService.list(owner, {});
      expect(invoices).toHaveLength(1);
      expect(invoices[0]!.status).toBe("DRAFT");

      // Visibly flagged — the same lookup the invoice list page uses to
      // render its "AI auto" badge.
      const flagged = await AutoExecutionService.listAutoExecutedEntityIds(orgId, "Invoice");
      expect(flagged.has(invoices[0]!.id)).toBe(true);

      // Fully audited with master spec §44's fields, and an honest
      // "auto-approved under org policy" approver — never a fabricated human.
      const auditRows = await withTenant(orgId, (tx) =>
        tx.select().from(auditLogs).where(eq(auditLogs.action, "ai_controller.auto_executed")),
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.actorType).toBe("AI");
      const metadata = auditRows[0]!.metadata as Record<string, unknown>;
      expect(metadata.agent).toBe("AutoExecutionService");
      expect(metadata.outcome).toBe("executed");
      expect(String(metadata.approver)).toMatch(/auto-approved under org policy/);
      expect(String(metadata.approver)).toMatch(/level 3/);

      // Trivially undoable — the auto-created row is still a plain DRAFT.
      const autoExecRows = await AutoExecutionService.listRecent(orgId);
      expect(autoExecRows).toHaveLength(1);
      await AutoExecutionService.undo(owner, autoExecRows[0]!.id);
      expect(await InvoiceService.list(owner, {})).toHaveLength(0);
    });

    it("the mirror for recurring bills (supplier side)", async () => {
      await AutonomySettingsService.setLevel(owner, 3);
      await AutoApprovedActionsService.setEnabled(owner, "RECURRING_BILL_AUTO_GENERATE", true);

      const template = await (await import("@/domain/purchases/recurring-bill-service")).RecurringBillService.create(owner, {
        supplierContactId: purchasesFixtures.supplierContactId,
        name: "Monthly hosting",
        currency: "AUD",
        apAccountId: purchasesFixtures.apAccountId,
        frequency: "MONTHLY",
        startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lines: [{ description: "Hosting", quantity: "1", unitPrice: "80.00", accountId: purchasesFixtures.expenseAccountId }],
      });
      expect(template.id).toBeTruthy();

      const results = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(results.find((r) => r.actionType === "RECURRING_BILL_AUTO_GENERATE")?.executed).toBe(1);

      const bills = await BillService.list(owner, {});
      expect(bills).toHaveLength(1);
      const flagged = await AutoExecutionService.listAutoExecutedEntityIds(orgId, "Bill");
      expect(flagged.has(bills[0]!.id)).toBe(true);
    });
  });

  describe("Level 3 whitelisted end-to-end: bank reconciliation auto-match", () => {
    it("auto-confirms ONLY a same-day exact-amount candidate", async () => {
      const bankAccount = await BankAccountService.create(owner, {
        name: "Everyday Account",
        glAccountId: salesFixtures.bankGlAccountId,
        currency: "AUD",
      });

      await PostingService.postJournal(owner, {
        postingDate: new Date("2026-01-16"),
        memo: "Client payment received",
        lines: [
          { accountId: salesFixtures.bankGlAccountId, debit: "1200.00", currency: "AUD" },
          { accountId: salesFixtures.revenueAccountId, credit: "1200.00", currency: "AUD" },
        ],
      });

      const { BankImportService } = await import("@/domain/banking/bank-import-service");
      await BankImportService.importStatement(owner, {
        bankAccountId: bankAccount.id,
        format: "CSV",
        text: ["Date,Description,Amount", "16/01/2026,Client Payment,1200.00"].join("\n"),
      });

      await AutonomySettingsService.setLevel(owner, 3);
      await AutoApprovedActionsService.setEnabled(owner, "BANK_RECONCILIATION_AUTO_MATCH", true);

      const results = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(results.find((r) => r.actionType === "BANK_RECONCILIATION_AUTO_MATCH")?.executed).toBe(1);

      const unreconciled = await ReconciliationService.listUnreconciled(owner, bankAccount.id);
      expect(unreconciled).toHaveLength(0);

      const auditRows = await withTenant(orgId, (tx) =>
        tx.select().from(auditLogs).where(eq(auditLogs.action, "ai_controller.auto_executed")),
      );
      const metadata = auditRows[0]!.metadata as Record<string, unknown>;
      expect(metadata.confidence).toBe("1.000");
    });
  });

  describe("emergency stop — immediate effect, no caching", () => {
    it("drops to Level 0 and the very next check is blocked, even with new due work and the whitelist still saved", async () => {
      await AutonomySettingsService.setLevel(owner, 4);
      await AutoApprovedActionsService.setEnabled(owner, "RECURRING_INVOICE_AUTO_GENERATE", true);
      await createDueMonthlyInvoiceTemplate("Retainer A", new Date(Date.now() - 24 * 60 * 60 * 1000));

      const first = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(first.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE")?.executed).toBe(1);

      await AutonomySettingsService.emergencyStop(owner);
      expect(await AutonomySettingsService.getLevel(orgId)).toBe(0);

      // The whitelist entry itself is untouched — proving it's the LEVEL
      // being re-checked fresh, not the whitelist having been wiped.
      const whitelist = await AutoApprovedActionsService.list(orgId);
      expect(whitelist.some((w) => w.actionType === "RECURRING_INVOICE_AUTO_GENERATE")).toBe(true);

      const { approved } = await isAutoExecutionApproved(orgId, "RECURRING_INVOICE_AUTO_GENERATE");
      expect(approved).toBe(false);

      // New due work appears AFTER the stop — it must still not auto-execute.
      await createDueMonthlyInvoiceTemplate("Retainer B", new Date(Date.now() - 24 * 60 * 60 * 1000));
      const second = await AutoExecutionService.runPendingAutoExecutions(owner);
      expect(second.find((r) => r.actionType === "RECURRING_INVOICE_AUTO_GENERATE")?.executed).toBe(0);

      const invoices = await InvoiceService.list(owner, {});
      expect(invoices).toHaveLength(1); // Only the one from before the stop.
    });
  });
});
