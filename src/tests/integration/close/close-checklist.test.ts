import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedCloseScenario, type CloseScenario } from "../../helpers/close";
import { createFixedAssetFixtures } from "../../helpers/fixed-assets";
import { createInventoryFixtures } from "../../helpers/inventory";
import { createPayrollFixtures } from "../../helpers/payroll";
import { AccountService } from "@/domain/accounts/account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { DepreciationService } from "@/domain/fixed-assets/depreciation-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { SignoffError } from "@/domain/close/errors";
import type { ChecklistItem, PeriodChecklist } from "@/domain/close/checklist-types";

describe("Month-end close checklist (Phase 9 Slice 3) — live checks", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let s: CloseScenario;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("close-checklist");
    owner = org.owner;
    currency = org.baseCurrency;
    s = await seedCloseScenario(owner, currency);
  });

  const item = (c: PeriodChecklist, idPrefix: string): ChecklistItem => {
    const found = c.items.find((i) => i.id.startsWith(idPrefix));
    if (!found) throw new Error(`no item ${idPrefix}; have ${c.items.map((i) => i.id).join(", ")}`);
    return found;
  };

  it("computes every automatic check live for an implicit month (no fiscal period row exists), with real figures, links and honest N/A", async () => {
    const c = await CloseChecklistService.compute(owner, "2026-09");
    expect(c.period).toMatchObject({ key: "2026-09", fiscalPeriodId: null, lockLevel: "OPEN" });

    const bank = item(c, "bank.unreconciled:");
    expect(bank).toMatchObject({ status: "ATTENTION", count: 1, kind: "AUTOMATIC", href: `/money/${s.bankAccountId}`, amount: "4.50" });
    expect(bank.detail).toBe("1 bank transaction in Everyday Account is unreconciled, totalling 4.50 in absolute value.");

    expect(item(c, "sales.draft_invoices")).toMatchObject({ status: "ATTENTION", count: 1, amount: "200.00", href: "/sales/invoices?status=DRAFT" });
    expect(item(c, "purchases.draft_bills").status).toBe("PASSED");
    expect(item(c, "expenses.submitted_claims").status).toBe("PASSED");
    expect(item(c, "payroll.draft_pay_runs").status).toBe("PASSED");
    expect(item(c, "ledger.trial_balance").status).toBe("PASSED");
    expect(item(c, "ledger.balance_sheet").status).toBe("PASSED");
    expect(item(c, "ledger.draft_journals").status).toBe("PASSED");

    // No fixed assets / tracked products / suspense accounts exist: N/A, never a fake tick.
    expect(item(c, "assets.depreciation").status).toBe("NOT_APPLICABLE");
    expect(item(c, "assets.register_reconciles").status).toBe("NOT_APPLICABLE");
    expect(item(c, "inventory.valuation_reconciles").status).toBe("NOT_APPLICABLE");
    expect(item(c, "ledger.suspense")).toMatchObject({ status: "NOT_APPLICABLE" });
    expect(item(c, "ledger.suspense").detail).toMatch(/does not create any by default/);

    // Automatic items are verified by the SYSTEM only when they pass; manual items are never.
    for (const i of c.items.filter((x) => x.kind === "AUTOMATIC" && x.status === "PASSED")) expect(i.verifiedBy).toBe("SYSTEM");
    const manual = c.items.filter((x) => x.kind === "MANUAL");
    expect(manual.map((m) => m.id)).toEqual(expect.arrayContaining(["manual.accruals", "manual.prepayments", "manual.tax_review", "manual.pnl_review", "manual.balance_sheet_review", "manual.foreign_exchange", "manual.intercompany", "manual.budget_variance"]));
    expect(manual.filter((m) => m.status === "MANUAL").length).toBeGreaterThanOrEqual(4);
    expect(manual.every((m) => m.verifiedBy !== "SYSTEM")).toBe(true);

    expect(c.blocking).toEqual([]);
    expect(c.outstanding.length).toBeGreaterThan(0);
    expect(c.progress.percent).toBeGreaterThan(0);
    expect(c.progress.percent).toBeLessThan(100);
    expect(c.progress.formula).toMatch(/PASSED/);
    expect(c.remaining.map((r) => r.id)).toEqual(expect.arrayContaining([bank.id, "sales.draft_invoices"]));
  });

  it("the checks flip when the underlying data is fixed, and the percentage rises (recomputed on every view, never stored)", async () => {
    const before = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(before, "bank.unreconciled:").status).toBe("ATTENTION");
    expect(item(before, "sales.draft_invoices").status).toBe("ATTENTION");

    await s.categorize();
    const afterBank = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(afterBank, "bank.unreconciled:")).toMatchObject({ status: "PASSED", verifiedBy: "SYSTEM", count: 0 });
    expect(item(afterBank, "sales.draft_invoices").status).toBe("ATTENTION");
    expect(afterBank.progress.percent).toBeGreaterThan(before.progress.percent);

    await s.approveInvoice();
    const afterInvoice = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(afterInvoice, "sales.draft_invoices").status).toBe("PASSED");
    expect(afterInvoice.progress.percent).toBeGreaterThan(afterBank.progress.percent);
    expect(afterInvoice.progress.complete).toBe(before.progress.complete + 2);
    // Ledger checks stay green: the posted fixes were balanced.
    expect(item(afterInvoice, "ledger.trial_balance").status).toBe("PASSED");
    expect(item(afterInvoice, "ledger.balance_sheet").status).toBe("PASSED");
  });

  it("a transaction dated AFTER the period end does not count against that period, but an older unreconciled one does", async () => {
    const octoberView = await CloseChecklistService.compute(owner, "2026-10");
    // The 15 Sep transaction is still unreconciled "through" 31 Oct.
    expect(item(octoberView, "bank.unreconciled:").status).toBe("ATTENTION");
    const august = await CloseChecklistService.compute(owner, "2026-08");
    expect(item(august, "bank.unreconciled:").status).toBe("PASSED");
  });

  it("depreciation: N/A with no assets; ATTENTION until run for the month; PASSED after running it — and the register reconciles to the ledger", async () => {
    const fa = await createFixedAssetFixtures(owner, currency);
    const cost = "12000.00";
    await PostingService.postJournal(owner, {
      postingDate: D("2026-08-01"),
      lines: [
        { accountId: fa.assetAccountId, debit: cost, currency },
        { accountId: fa.openingBalanceEquityAccountId, credit: cost, currency },
      ],
    });
    await FixedAssetService.registerAsset(owner, {
      assetClassId: fa.assetClassId,
      name: "Van",
      acquisitionDate: D("2026-08-01"),
      acquisitionCost: cost,
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      usefulLifeMonths: 60,
    });

    const before = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(before, "assets.depreciation")).toMatchObject({ status: "ATTENTION", count: 1 });
    expect(item(before, "assets.depreciation").detail).toContain("not been run for 2026-09 for 1 of 1 active asset");
    expect(item(before, "assets.register_reconciles").status).toBe("PASSED");

    await DepreciationService.runForPeriod(owner, { periodMonth: D("2026-09-01") });
    const after = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(after, "assets.depreciation")).toMatchObject({ status: "PASSED", verifiedBy: "SYSTEM" });
    expect(item(after, "assets.register_reconciles").status).toBe("PASSED");
    // Depreciation for an earlier month was never run — August still needs attention.
    expect((await CloseChecklistService.compute(owner, "2026-08")).items.find((i) => i.id === "assets.depreciation")!.status).toBe("ATTENTION");
    // An asset not yet acquired by the period end makes the check not applicable for that period.
    expect((await CloseChecklistService.compute(owner, "2026-07")).items.find((i) => i.id === "assets.depreciation")!.status).toBe("NOT_APPLICABLE");
  });

  it("fixed asset register out of step with the ledger is BLOCKING", async () => {
    const fa = await createFixedAssetFixtures(owner, currency);
    // Registered without ever posting the acquisition: the register says 5,000, the ledger says 0.
    await FixedAssetService.registerAsset(owner, {
      assetClassId: fa.assetClassId,
      name: "Unposted laptop",
      acquisitionDate: D("2026-08-01"),
      acquisitionCost: "5000.00",
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      usefulLifeMonths: 36,
    });
    const c = await CloseChecklistService.compute(owner, "2026-09");
    const reg = item(c, "assets.register_reconciles");
    expect(reg.status).toBe("BLOCKING");
    expect(reg.detail).toContain("do not reconcile to the general ledger");
    expect(c.blocking.map((b) => b.id)).toContain("assets.register_reconciles");
  });

  it("inventory valuation check: N/A without tracked products, PASSED (reconciles) with one", async () => {
    expect(item(await CloseChecklistService.compute(owner, "2026-09"), "inventory.valuation_reconciles").status).toBe("NOT_APPLICABLE");
    await createInventoryFixtures(owner, currency);
    const c = await CloseChecklistService.compute(owner, "2026-09");
    expect(item(c, "inventory.valuation_reconciles")).toMatchObject({ status: "PASSED", verifiedBy: "SYSTEM" });
  });

  it("suspense/clearing: appears only when the organization itself has such an account, and flags a non-zero balance", async () => {
    const suspense = await AccountService.create(owner, { code: "1999", name: "Suspense", type: "ASSET", currency });
    expect(item(await CloseChecklistService.compute(owner, "2026-09"), "ledger.suspense").status).toBe("PASSED");
    await PostingService.postJournal(owner, {
      postingDate: D("2026-09-20"),
      lines: [
        { accountId: suspense.id, debit: "75.00", currency },
        { accountId: s.revenue, credit: "75.00", currency },
      ],
    });
    const c = await CloseChecklistService.compute(owner, "2026-09");
    const sus = item(c, "ledger.suspense");
    expect(sus).toMatchObject({ status: "ATTENTION", count: 1, amount: "75.00" });
    expect(sus.detail).toContain("1999 Suspense (75.00)");
  });

  it("sequencing: closing October while September is still open is an ATTENTION warning, not a block", async () => {
    await PostingService.postJournal(owner, {
      postingDate: D("2026-10-05"),
      lines: [
        { accountId: s.bankGl, debit: "10.00", currency },
        { accountId: s.revenue, credit: "10.00", currency },
      ],
    });
    const c = await CloseChecklistService.compute(owner, "2026-10");
    expect(item(c, "ledger.prior_period")).toMatchObject({ status: "ATTENTION" });
    expect(item(c, "ledger.prior_period").detail).toContain("2026-09");
    expect(c.blocking.map((b) => b.id)).not.toContain("ledger.prior_period");
    // September has activity before it only from... nothing earlier, so it has no predecessor to warn about.
    expect(item(await CloseChecklistService.compute(owner, "2026-09"), "ledger.prior_period").status).toBe("NOT_APPLICABLE");
  });

  describe("payroll visibility", () => {
    it("a DRAFT pay run in the period is flagged for a role with payrun:read, and the item is omitted (counted as hidden) for one without", async () => {
      const wiring = await createPayrollFixtures(owner, currency);
      const employee = await EmployeeService.create(owner, {
        name: "Alex Salary",
        employmentBasis: "SALARY",
        annualSalary: "104000.00",
        payFrequency: "FORTNIGHTLY",
        taxFreeThresholdClaimed: true,
        startDate: D("2026-01-01"),
      });
      await PayRunService.create(
        owner,
        { payFrequency: "FORTNIGHTLY", periodStart: D("2026-09-05"), periodEnd: D("2026-09-18"), payDate: D("2026-09-18"), employeeIds: [employee.id] },
        wiring,
      );

      const full = await CloseChecklistService.compute(owner, "2026-09");
      expect(item(full, "payroll.draft_pay_runs")).toMatchObject({ status: "ATTENTION", count: 1, href: "/payroll/pay-runs" });
      expect(full.hiddenCount).toBe(0);

      // MANAGER has close_checklist:read but not payrun:read.
      const manager = actorWithRole(owner, "MANAGER");
      const redacted = await CloseChecklistService.compute(manager, "2026-09");
      expect(redacted.items.find((i) => i.id.startsWith("payroll."))).toBeUndefined();
      expect(redacted.hiddenCount).toBeGreaterThan(0);
      expect(JSON.stringify(redacted)).not.toMatch(/pay run/i);
      // The percentage is computed over what the role can see.
      expect(redacted.progress.applicable).toBeLessThan(full.progress.applicable);
    });

    it("a role that cannot see every item cannot close the period", async () => {
      // Closing needs period:close, which no role lacking payrun:read holds by default; prove the guard directly.
      const manager = actorWithRole(owner, "MANAGER");
      await expect(PeriodCloseService.close(manager, "2026-09", { acknowledgeOutstanding: true })).rejects.toThrow(PermissionDeniedError);
    });
  });

  it("is refused for a role without close_checklist:read", async () => {
    await expect(CloseChecklistService.compute(actorWithRole(owner, "EMPLOYEE"), "2026-09")).rejects.toThrow(PermissionDeniedError);
    await expect(CloseChecklistService.compute(actorWithRole(owner, "ACCOUNTS_PAYABLE"), "2026-09")).rejects.toThrow(PermissionDeniedError);
    await expect(CloseChecklistService.compute(actorWithRole(owner, "BOOKKEEPER"), "2026-09")).resolves.toBeDefined();
  });

  describe("manual sign-offs", () => {
    it("record identity, timestamp and note, are labelled MANUAL (never system-verified), and move the percentage", async () => {
      const accountant = actorWithRole(owner, "ACCOUNTANT");
      const before = await CloseChecklistService.compute(owner, "2026-09");
      expect(item(before, "manual.accruals")).toMatchObject({ kind: "MANUAL", status: "MANUAL", signoff: null });

      await PeriodCloseService.signOff(accountant, "2026-09", "manual.accruals", "Checked the accrual schedule");
      const after = await CloseChecklistService.compute(owner, "2026-09");
      const accruals = item(after, "manual.accruals");
      expect(accruals).toMatchObject({ kind: "MANUAL", status: "PASSED", verifiedBy: "HUMAN" });
      expect(accruals.signoff).toMatchObject({ signedById: owner.userId, note: "Checked the accrual schedule" });
      expect(accruals.signoff!.signedByName).toContain("Owner");
      expect(Date.now() - new Date(accruals.signoff!.signedAt).getTime()).toBeLessThan(60_000);
      expect(after.progress.complete).toBe(before.progress.complete + 1);

      // The month now exists as a period row, in progress.
      expect(after.period.fiscalPeriodId).not.toBeNull();
    });

    it("cannot be signed twice, can be revoked (audited), needs close_checklist:manage, and unknown keys are refused", async () => {
      await PeriodCloseService.signOff(owner, "2026-09", "manual.tax_review");
      await expect(PeriodCloseService.signOff(owner, "2026-09", "manual.tax_review")).rejects.toThrow(SignoffError);
      await expect(PeriodCloseService.signOff(owner, "2026-09", "manual.made_up")).rejects.toThrow(SignoffError);
      await expect(PeriodCloseService.signOff(owner, "2026-09", "ledger.trial_balance")).rejects.toThrow(SignoffError);
      await expect(PeriodCloseService.signOff(actorWithRole(owner, "BOOKKEEPER"), "2026-09", "manual.prepayments")).rejects.toThrow(PermissionDeniedError);

      await PeriodCloseService.revokeSignOff(owner, "2026-09", "manual.tax_review");
      expect(item(await CloseChecklistService.compute(owner, "2026-09"), "manual.tax_review").status).toBe("MANUAL");
      await expect(PeriodCloseService.revokeSignOff(owner, "2026-09", "manual.tax_review")).rejects.toThrow(SignoffError);
    });

    it("foreign exchange appears as MANUAL only when foreign-currency lines were posted in the period", async () => {
      expect(item(await CloseChecklistService.compute(owner, "2026-09"), "manual.foreign_exchange").status).toBe("NOT_APPLICABLE");
      await PostingService.postJournal(owner, {
        postingDate: D("2026-09-12"),
        lines: [
          { accountId: s.bankGl, debit: "150.00", currency: "USD", exchangeRate: "1.5" },
          { accountId: s.revenue, credit: "225.00", currency },
        ],
      });
      const fx = item(await CloseChecklistService.compute(owner, "2026-09"), "manual.foreign_exchange");
      expect(fx.status).toBe("MANUAL");
      expect(fx.detail).toContain("1 foreign-currency line");
    });
  });

  it("the period list shows months (including implicit ones), live progress only for the focus month, and effective locks from covering periods", async () => {
    const { FiscalPeriodService } = await import("@/domain/ledger/fiscal-period-service");
    const fy = await FiscalPeriodService.create(owner, { label: "FY2026", startDate: D("2025-07-01"), endDate: D("2026-06-30") });
    await PostingService.postJournal(owner, {
      postingDate: D("2026-05-10"),
      lines: [
        { accountId: s.bankGl, debit: "1.00", currency },
        { accountId: s.revenue, credit: "1.00", currency },
      ],
    });
    await FiscalPeriodService.setStatus(owner, fy.id, "HARD_LOCKED", "Prior year closed and filed");

    const list = await PeriodCloseService.listPeriods(owner, new Date("2026-10-05T00:00:00Z"));
    const keys = list.filter((p) => p.kind === "MONTH").map((p) => p.key);
    expect(keys.slice(0, 2)).toEqual(["2026-10", "2026-09"]);
    expect(keys).toContain("2026-05");
    const sep = list.find((p) => p.key === "2026-09")!;
    expect(sep).toMatchObject({ fiscalPeriodId: null, ownLevel: "OPEN", effectiveLevel: "OPEN", closeStatus: "NOT_STARTED" });
    expect(sep.livePercent).not.toBeNull(); // the focus: previous month, unlocked
    expect(list.find((p) => p.key === "2026-10")!.livePercent).toBeNull();
    const fyRow = list.find((p) => p.kind === "RANGE" && p.label === "FY2026")!;
    expect(fyRow).toMatchObject({ ownLevel: "HARD_LOCKED", effectiveLevel: "HARD_LOCKED" });
    // A month inside the locked year shows the lock that covers it, and is not offered live progress.
    const may = list.find((p) => p.key === "2026-05")!;
    expect(may).toMatchObject({ ownLevel: "OPEN", effectiveLevel: "HARD_LOCKED" });
    expect(may.coveredBy.map((c) => c.label)).toEqual(["FY2026"]);
  });
});
