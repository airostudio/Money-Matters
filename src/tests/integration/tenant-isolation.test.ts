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
  purchaseOrders,
  quotes,
  recurringBillTemplates,
  recurringInvoiceTemplates,
  supplierCreditNotes,
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
});
