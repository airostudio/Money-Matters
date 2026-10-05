import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeTestPools, createTestOrg, resetDatabase } from "../helpers/db";
import { createSampleAccounts } from "../helpers/ledger";
import { createSalesFixtures } from "../helpers/sales";
import { createPurchasesFixtures } from "../helpers/purchases";
import {
  accounts,
  auditLogs,
  bills,
  expenseClaims,
  invoices,
  paymentRuns,
  projectTasks,
  projects,
  purchaseOrders,
  quotes,
  recurringBillTemplates,
  recurringInvoiceTemplates,
  savedReports,
  supplierCreditNotes,
  timesheetEntries,
  products,
  inventoryMovements,
  inventoryAdjustments,
  fixedAssets,
  depreciationEntries,
  employees,
  payRuns,
  payRunLines,
} from "@/db/schema";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { AccountService } from "@/domain/accounts/account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { QuoteService } from "@/domain/sales/quote-service";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { createExpenseFixtures } from "../helpers/expenses";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { ReportBuilderService } from "@/domain/reporting/report-builder-service";
import { ProjectService } from "@/domain/projects/project-service";
import { TimesheetService } from "@/domain/projects/timesheet-service";
import { ProductService } from "@/domain/inventory/product-service";
import { InventoryAdjustmentService } from "@/domain/inventory/inventory-adjustment-service";
import { createInventoryFixtures } from "../helpers/inventory";
import { createFixedAssetFixtures } from "../helpers/fixed-assets";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { DepreciationService } from "@/domain/fixed-assets/depreciation-service";
import { createPayrollFixtures } from "../helpers/payroll";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { budgetLines, budgets, cashForecastSettings, scenarios } from "@/db/schema";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import { ForecastSettingsService } from "@/domain/forecasting/forecast-settings-service";

/**
 * Master spec §48 / §87 non-negotiable #7: "A coding mistake must not allow
 * Company A to retrieve Company B's data." These tests deliberately mimic
 * an application-layer mistake — a query that forgets its organizationId
 * filter — and confirm the Row-Level Security backstop (see
 * drizzle/0001_row_level_security.sql, docs/security.md §2) still prevents
 * cross-tenant reads and writes, so isolation does not depend solely on
 * every service method remembering to filter correctly.
 */
describe("Tenant isolation", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let orgA: Awaited<ReturnType<typeof createTestOrg>>;
  let orgB: Awaited<ReturnType<typeof createTestOrg>>;
  let orgAAccountIds: string[];
  let orgBAccountIds: string[];
  let orgAAccountId: string;
  let orgBAccountId: string;

  beforeEach(async () => {
    await resetDatabase();
    orgA = await createTestOrg("tenant-a");
    orgB = await createTestOrg("tenant-b");
    orgAAccountIds = await createSampleAccounts(orgA.owner, orgA.baseCurrency);
    orgBAccountIds = await createSampleAccounts(orgB.owner, orgB.baseCurrency);
    orgAAccountId = orgAAccountIds[0]!;
    orgBAccountId = orgBAccountIds[0]!;

    await PostingService.postJournal(orgA.owner, {
      postingDate: new Date(),
      lines: [
        { accountId: orgAAccountId, debit: "42.00", currency: "AUD" },
        { accountId: orgAAccountIds[1]!, credit: "42.00", currency: "AUD" },
      ],
    });
  });

  it("RLS blocks a query with NO tenant context set at all, even for real rows", async () => {
    // Simulates a code path that queries the shared `db` client directly
    // instead of going through withTenant() — app.current_org_id is unset.
    const rows = await db.select().from(accounts);
    expect(rows).toHaveLength(0);
  });

  it("RLS returns only the scoped org's rows even when the query itself has no WHERE filter", async () => {
    const rowsAsOrgA = await withTenant(orgA.organizationId, (tx) => tx.select().from(accounts));
    expect(rowsAsOrgA.every((r) => r.organizationId === orgA.organizationId)).toBe(true);
    expect(rowsAsOrgA.some((r) => r.id === orgBAccountId)).toBe(false);

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(accounts));
    expect(rowsAsOrgB.every((r) => r.organizationId === orgB.organizationId)).toBe(true);
    expect(rowsAsOrgB.some((r) => r.id === orgAAccountId)).toBe(false);
  });

  it("RLS protects the append-only audit log the same way", async () => {
    const rowsAsOrgA = await withTenant(orgA.organizationId, (tx) => tx.select().from(auditLogs));
    expect(rowsAsOrgA.length).toBeGreaterThan(0);
    expect(rowsAsOrgA.every((r) => r.organizationId === orgA.organizationId)).toBe(true);
  });

  it("domain service layer also refuses to serve another org's resource by id", async () => {
    const result = await AccountService.get(orgA.owner, orgBAccountId);
    expect(result).toBeNull();
  });

  it("rejects posting a journal line against another org's account even with a valid actor", async () => {
    await expect(
      PostingService.postJournal(orgA.owner, {
        postingDate: new Date(),
        lines: [
          { accountId: orgBAccountId, debit: "10.00", currency: "AUD" },
          { accountId: orgAAccountIds[2]!, credit: "10.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("every tenant table has RLS both ENABLED and FORCED", async () => {
    // FORCE matters separately from ENABLE: PostgreSQL exempts a table's
    // OWNER from its own row-level security unless FORCE is set. Without it,
    // pointing the app's connection at the migration/admin role silently
    // disables tenant isolation while appearing to work — see
    // drizzle/0002_force_row_level_security.sql.
    const tenantTables = [
      "accounts",
      "fiscal_periods",
      "exchange_rates",
      "tax_codes",
      "contacts",
      "dimensions",
      "dimension_values",
      "journal_line_dimensions",
      "approvals",
      "journal_entries",
      "journal_lines",
      "audit_logs",
      "invoices",
      "invoice_lines",
      "payments",
      "payment_allocations",
      "quotes",
      "quote_lines",
      "recurring_invoice_templates",
      "recurring_invoice_template_lines",
      "invoice_recurring_source",
      "bills",
      "bill_lines",
      "supplier_payments",
      "supplier_payment_allocations",
      "expense_claims",
      "expense_claim_lines",
      "uploaded_receipts",
      "purchase_orders",
      "purchase_order_lines",
      "purchase_order_receipts",
      "purchase_order_receipt_lines",
      "recurring_bill_templates",
      "recurring_bill_template_lines",
      "bill_recurring_source",
      "supplier_credit_notes",
      "supplier_credit_note_lines",
      "supplier_credit_allocations",
      "payment_runs",
      "payment_run_items",
      "saved_reports",
      "projects",
      "project_tasks",
      "timesheet_entries",
      "products",
      "inventory_movements",
      "inventory_adjustments",
      "fixed_asset_classes",
      "fixed_assets",
      "depreciation_entries",
      "employees",
      "pay_runs",
      "pay_run_lines",
      "budgets",
      "budget_lines",
      "scenarios",
      "cash_forecast_settings",
    ];

    const rows = await db.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    `);

    const byName = new Map(rows.rows.map((r) => [r.relname, r]));
    for (const table of tenantTables) {
      const row = byName.get(table);
      expect(row, `${table} should exist`).toBeDefined();
      expect(row?.relrowsecurity, `${table} should have RLS enabled`).toBe(true);
      expect(row?.relforcerowsecurity, `${table} should have RLS forced`).toBe(true);
    }
  });

  it("an invoice created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createSalesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await InvoiceService.create(orgA.owner, {
      customerContactId: fixturesA.customerContactId,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: "AUD",
      arAccountId: fixturesA.arAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.revenueAccountId }],
    });

    expect(await InvoiceService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(invoices));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(invoices);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a bill created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createPurchasesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await BillService.create(orgA.owner, {
      supplierContactId: fixturesA.supplierContactId,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: "AUD",
      apAccountId: fixturesA.apAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.expenseAccountId }],
    });

    expect(await BillService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(bills));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(bills);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a purchase order created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createPurchasesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await PurchaseOrderService.create(orgA.owner, {
      supplierContactId: fixturesA.supplierContactId,
      issueDate: new Date(),
      currency: "AUD",
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.expenseAccountId }],
    });

    expect(await PurchaseOrderService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(purchaseOrders));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(purchaseOrders);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a recurring bill template created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createPurchasesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await RecurringBillService.create(orgA.owner, {
      supplierContactId: fixturesA.supplierContactId,
      name: "Monthly hosting",
      currency: "AUD",
      apAccountId: fixturesA.apAccountId,
      frequency: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.expenseAccountId }],
    });

    expect(await RecurringBillService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(recurringBillTemplates));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(recurringBillTemplates);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a supplier credit note created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createPurchasesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await SupplierCreditService.create(orgA.owner, {
      supplierContactId: fixturesA.supplierContactId,
      issueDate: new Date(),
      currency: "AUD",
      apAccountId: fixturesA.apAccountId,
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.expenseAccountId }],
    });

    expect(await SupplierCreditService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(supplierCreditNotes));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(supplierCreditNotes);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a payment run created under org A is invisible to org B, even by direct query with no filter", async () => {
    const created = await PaymentRunService.create(orgA.owner, {
      paymentDate: new Date(),
      currency: "AUD",
      paymentAccountId: orgAAccountId,
      billIds: [],
    });

    expect(await PaymentRunService.get(orgB.owner, created!.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(paymentRuns));
    expect(rowsAsOrgB.some((r) => r.id === created!.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(paymentRuns);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("an expense claim created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createExpenseFixtures(orgA.owner, orgA.baseCurrency);
    const created = await ExpenseClaimService.create(orgA.owner, {
      employeeUserId: orgA.owner.userId,
      claimDate: new Date(),
      description: "x",
      currency: "AUD",
      payableAccountId: fixturesA.payableAccountId,
      lines: [{ description: "x", amount: "10.00", expenseAccountId: fixturesA.expenseAccountId }],
    });

    expect(await ExpenseClaimService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(expenseClaims));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(expenseClaims);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a quote created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createSalesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await QuoteService.create(orgA.owner, {
      customerContactId: fixturesA.customerContactId,
      issueDate: new Date(),
      expiryDate: new Date(),
      currency: "AUD",
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.revenueAccountId }],
    });

    expect(await QuoteService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(quotes));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(quotes);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a recurring invoice template created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createSalesFixtures(orgA.owner, orgA.baseCurrency);
    const created = await RecurringInvoiceService.create(orgA.owner, {
      customerContactId: fixturesA.customerContactId,
      name: "Monthly retainer",
      currency: "AUD",
      arAccountId: fixturesA.arAccountId,
      frequency: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: fixturesA.revenueAccountId }],
    });

    expect(await RecurringInvoiceService.get(orgB.owner, created.id)).toBeNull();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(recurringInvoiceTemplates));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(recurringInvoiceTemplates);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("org B's financial statements never include org A's posted activity", async () => {
    const fixturesA = await createSalesFixtures(orgA.owner, orgA.baseCurrency);
    const invoiceA = await InvoiceService.create(orgA.owner, {
      customerContactId: fixturesA.customerContactId,
      issueDate: new Date("2026-05-01"),
      dueDate: new Date("2026-05-15"),
      currency: "AUD",
      arAccountId: fixturesA.arAccountId,
      lines: [
        { description: "Org A revenue", quantity: "1", unitPrice: "9999.00", accountId: fixturesA.revenueAccountId },
      ],
    });
    await InvoiceService.approveAndPost(orgA.owner, invoiceA.id);

    const orgBPnl = await ReportingService.getProfitAndLoss(orgB.owner, {
      from: new Date("2026-05-01"),
      to: new Date("2026-05-31"),
    });
    expect(orgBPnl.totalRevenue).toBe("0.0000");

    const orgBBalanceSheet = await ReportingService.getBalanceSheet(orgB.owner, new Date("2026-05-31"));
    expect(orgBBalanceSheet.assets.some((l) => l.accountId === fixturesA.arAccountId)).toBe(false);

    // Even a drill-down request for org A's own account, made as org B,
    // finds nothing — the account itself doesn't resolve cross-tenant.
    const crossTenantAccount = await ReportingService.getAccount(orgB.owner, fixturesA.arAccountId);
    expect(crossTenantAccount).toBeNull();
  });

  it("RLS rejects an INSERT for an org other than the one scoped on the connection", async () => {
    await expect(
      withTenant(orgA.organizationId, (tx) =>
        tx.insert(accounts).values({
          organizationId: orgB.organizationId,
          code: "9999",
          name: "hack",
          type: "ASSET",
          currency: "AUD",
        }),
      ),
    ).rejects.toThrow();

    const leaked = await withTenant(orgB.organizationId, (tx) =>
      tx.select().from(accounts).where(eq(accounts.code, "9999")),
    );
    expect(leaked).toHaveLength(0);
  });

  it("a saved report created under org A is invisible to org B, even by direct query with no filter, and cannot be run or deleted as org B", async () => {
    const created = await ReportBuilderService.saveReport(orgA.owner, {
      name: "Org A's report",
      visibility: "ORGANIZATION",
      config: {
        rowGroupBy: "ACCOUNT_TYPE",
        accountTypes: ["REVENUE"],
        measure: "MOVEMENT",
        periodBreakdown: "NONE",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
    });

    expect(await ReportBuilderService.getSavedReport(orgB.owner, created.id)).toBeNull();
    await expect(ReportBuilderService.runSavedReport(orgB.owner, created.id)).rejects.toThrow();
    await expect(ReportBuilderService.deleteSavedReport(orgB.owner, created.id)).rejects.toThrow();

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(savedReports));
    expect(rowsAsOrgB.some((r) => r.id === created.id)).toBe(false);

    const rowsWithNoTenantContext = await db.select().from(savedReports);
    expect(rowsWithNoTenantContext).toHaveLength(0);
  });

  it("a project (and its task and timesheet entries) created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createSalesFixtures(orgA.owner, orgA.baseCurrency);
    const project = await ProjectService.create(orgA.owner, {
      customerContactId: fixturesA.customerContactId,
      code: "TENANT-A-PROJ",
      name: "Org A's project",
      currency: "AUD",
    });
    const task = await ProjectService.createTask(orgA.owner, project.id, { name: "Org A's task" });
    const entry = await TimesheetService.createManual(orgA.owner, {
      employeeUserId: orgA.owner.userId,
      projectId: project.id,
      taskId: task.id,
      entryDate: new Date(),
      hours: "2.00",
    });

    expect(await ProjectService.get(orgB.owner, project.id)).toBeNull();
    await expect(TimesheetService.get(orgB.owner, entry.id)).rejects.toThrow();

    const projectsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(projects));
    expect(projectsAsOrgB.some((r) => r.id === project.id)).toBe(false);
    const tasksAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(projectTasks));
    expect(tasksAsOrgB.some((r) => r.id === task.id)).toBe(false);
    const entriesAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(timesheetEntries));
    expect(entriesAsOrgB.some((r) => r.id === entry.id)).toBe(false);

    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(projectTasks)).toHaveLength(0);
    expect(await db.select().from(timesheetEntries)).toHaveLength(0);
  });

  it("a product (and its movements and adjustments) created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createInventoryFixtures(orgA.owner, orgA.baseCurrency);

    expect(await ProductService.get(orgB.owner, fixturesA.productId)).toBeNull();

    const adjustment = await InventoryAdjustmentService.create(orgA.owner, {
      productId: fixturesA.productId,
      quantityDelta: "5",
      unitCost: "10.00",
      reason: "Initial stock",
      adjustmentAccountId: fixturesA.adjustmentAccountId,
    });

    const productsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(products));
    expect(productsAsOrgB.some((r) => r.id === fixturesA.productId)).toBe(false);
    const movementsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(inventoryMovements));
    expect(movementsAsOrgB.some((r) => r.productId === fixturesA.productId)).toBe(false);
    const adjustmentsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(inventoryAdjustments));
    expect(adjustmentsAsOrgB.some((r) => r.id === adjustment.id)).toBe(false);

    expect(await db.select().from(products)).toHaveLength(0);
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);
    expect(await db.select().from(inventoryAdjustments)).toHaveLength(0);
  });

  it("a fixed asset (and its depreciation entries) created under org A is invisible to org B, even by direct query with no filter", async () => {
    const fixturesA = await createFixedAssetFixtures(orgA.owner, orgA.baseCurrency);

    await PostingService.postJournal(orgA.owner, {
      postingDate: new Date("2026-01-01"),
      lines: [
        { accountId: fixturesA.assetAccountId, debit: "12000.00", currency: orgA.baseCurrency },
        { accountId: fixturesA.openingBalanceEquityAccountId, credit: "12000.00", currency: orgA.baseCurrency },
      ],
    });
    const asset = await FixedAssetService.registerAsset(orgA.owner, {
      assetClassId: fixturesA.assetClassId,
      name: "Delivery Van",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "12000.00",
      assetAccountId: fixturesA.assetAccountId,
      accumulatedDepreciationAccountId: fixturesA.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fixturesA.depreciationExpenseAccountId,
    });

    expect(await FixedAssetService.get(orgB.owner, asset.id)).toBeNull();

    await DepreciationService.runForPeriod(orgA.owner, { periodMonth: new Date("2026-01-15") });

    const assetsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(fixedAssets));
    expect(assetsAsOrgB.some((r) => r.id === asset.id)).toBe(false);
    const entriesAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(depreciationEntries));
    expect(entriesAsOrgB.some((r) => r.assetId === asset.id)).toBe(false);

    expect(await db.select().from(fixedAssets)).toHaveLength(0);
    expect(await db.select().from(depreciationEntries)).toHaveLength(0);
  });

  it("an employee (and its pay run/pay run lines) created under org A is invisible to org B, even by direct query with no filter", async () => {
    const gl = await createPayrollFixtures(orgA.owner, orgA.baseCurrency);
    const employee = await EmployeeService.create(orgA.owner, {
      name: "Isolated Employee",
      employmentBasis: "SALARY",
      annualSalary: "80000.00",
      payFrequency: "MONTHLY",
      startDate: new Date("2026-01-01"),
      tfn: "999999999",
    });

    expect(await EmployeeService.get(orgB.owner, employee.id).catch(() => null)).toBeNull();

    const run = await PayRunService.create(
      orgA.owner,
      {
        payFrequency: "MONTHLY",
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-31"),
        payDate: new Date("2026-10-31"),
        employeeIds: [employee.id],
      },
      gl,
    );
    await PayRunService.post(orgA.owner, run.id);

    await expect(PayRunService.get(orgB.owner, run.id)).rejects.toThrow();

    const employeesAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(employees));
    expect(employeesAsOrgB.some((r) => r.id === employee.id)).toBe(false);
    const payRunsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(payRuns));
    expect(payRunsAsOrgB.some((r) => r.id === run.id)).toBe(false);
    const payRunLinesAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(payRunLines));
    expect(payRunLinesAsOrgB.some((r) => r.payRunId === run.id)).toBe(false);

    expect(await db.select().from(employees)).toHaveLength(0);
    expect(await db.select().from(payRuns)).toHaveLength(0);
    expect(await db.select().from(payRunLines)).toHaveLength(0);
  });

  it("a budget (and its lines) created under org A is invisible to org B, even by direct query with no filter", async () => {
    const budget = await BudgetService.create(orgA.owner, {
      name: "Org A's budget",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-12-31"),
    });
    await BudgetService.setAccountLines(orgA.owner, budget.id, {
      accountId: orgAAccountIds[4]!,
      months: [{ month: new Date("2026-01-01"), amount: "1000.00" }],
    });

    expect(await BudgetService.get(orgB.owner, budget.id)).toBeNull();

    const budgetsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(budgets));
    expect(budgetsAsOrgB.some((r) => r.id === budget.id)).toBe(false);
    const linesAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(budgetLines));
    expect(linesAsOrgB.some((r) => r.budgetId === budget.id)).toBe(false);

    expect(await db.select().from(budgets)).toHaveLength(0);
    expect(await db.select().from(budgetLines)).toHaveLength(0);
  });

  it("a saved scenario and a cash-forecast setting created under org A are invisible to org B, even by direct query with no filter", async () => {
    const scenario = await ScenarioService.create(orgA.owner, {
      name: "Org A's hire",
      type: "HIRE_EMPLOYEE",
      parameters: { annualSalary: "90000", onCostPercent: "12", startDate: "2026-11-01" },
    });
    await ForecastSettingsService.setLowCashThreshold(orgA.owner, "5000.00");

    expect(await ScenarioService.get(orgB.owner, scenario.id)).toBeNull();
    expect(await ScenarioService.list(orgB.owner)).toHaveLength(0);
    await expect(ScenarioService.run(orgB.owner, scenario.id)).rejects.toThrow();
    // Org B still sees the documented default, not org A's threshold.
    expect((await ForecastSettingsService.get(orgB.owner)).lowCashThreshold).toBe("0.0000");

    const scenariosAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(scenarios));
    expect(scenariosAsOrgB.some((r) => r.id === scenario.id)).toBe(false);
    const settingsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(cashForecastSettings));
    expect(settingsAsOrgB).toHaveLength(0);

    // With no tenant context at all (the application role, no org set), RLS returns nothing either.
    expect(await db.select().from(scenarios)).toHaveLength(0);
    expect(await db.select().from(cashForecastSettings)).toHaveLength(0);
  });
});
