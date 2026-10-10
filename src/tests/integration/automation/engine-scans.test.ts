import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { auditLogs, bills, journalEntries, purchaseOrderLines, purchaseOrders } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createInventoryFixtures } from "../../helpers/inventory";
import { jobsOf, makeRule, notificationsOf, passDeps, ruleRow, runsOf } from "../../helpers/automation";
import { AutomationEngine } from "@/domain/automation/engine";
import { resolveExecutionIdentity } from "@/domain/automation/identity";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { ProductService } from "@/domain/inventory/product-service";
import { InventoryAdjustmentService } from "@/domain/inventory/inventory-adjustment-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

/** Condition scans: overdue invoices, bills due soon, stock at its reorder point (docs/architecture.md section 13). */
describe("automation engine: condition scans", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  let inventory: Awaited<ReturnType<typeof createInventoryFixtures>>;
  let currency: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("auto-scans");
    owner = org.owner;
    orgId = org.organizationId;
    currency = org.baseCurrency;
    sales = await createSalesFixtures(owner, currency);
    purchases = await createPurchasesFixtures(owner, currency);
    inventory = await createInventoryFixtures(owner, currency);
  });

  const notify = { type: "NOTIFY_IN_APP" as const, roles: ["OWNER"], userIds: [] as string[], severity: "WARNING" as const, includeAmounts: false };
  const at = (iso: string) => ({ now: () => new Date(iso) });
  const pass = (iso: string, extra = {}) => AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ ...at(iso), ...extra }));

  async function approvedInvoice(dueDate: string, unitPrice = "100.00") {
    const created = await InvoiceService.create(owner, {
      customerContactId: sales.customerContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date(dueDate),
      currency,
      arAccountId: sales.arAccountId,
      lines: [{ description: "Consulting", quantity: "10", unitPrice, accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
    });
    await InvoiceService.approveAndPost(owner, created.id);
    return created;
  }
  async function approvedBill(dueDate: string) {
    const created = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date(dueDate),
      currency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Paper", quantity: "2", unitPrice: "50.00", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId }],
    });
    await BillService.approveAndPost(owner, created.id);
    return created;
  }

  describe("INVOICE_OVERDUE", () => {
    it("fires once per invoice per rule at N days past due; a re-run, or the passage of time, never fires it again", async () => {
      const seven = await makeRule(owner, { name: "7 days", trigger: "INVOICE_OVERDUE", triggerParams: { days: 7 }, action: notify });
      const thirty = await makeRule(owner, { name: "30 days", trigger: "INVOICE_OVERDUE", triggerParams: { days: 30 }, action: notify });
      const invoice = await approvedInvoice("2026-01-31");

      await pass("2026-02-06T10:00:00Z"); // 6 days overdue: not yet
      expect(await runsOf(orgId)).toHaveLength(0);
      await pass("2026-02-07T10:00:00Z"); // exactly 7 days
      expect((await runsOf(orgId, seven)).map((r) => r.jobKey)).toEqual([`invoice:${invoice.id}:overdue:7`]);
      expect(await runsOf(orgId, thirty)).toHaveLength(0);
      await pass("2026-02-07T10:05:00Z");
      await pass("2026-02-20T10:00:00Z");
      expect(await runsOf(orgId, seven)).toHaveLength(1); // once per invoice per rule
      await pass("2026-03-02T10:00:00Z"); // 30 days
      expect((await runsOf(orgId, thirty)).map((r) => r.jobKey)).toEqual([`invoice:${invoice.id}:overdue:30`]);
      expect(await runsOf(orgId, seven)).toHaveLength(1);
      expect(await notificationsOf(orgId)).toHaveLength(2);
    });

    it("ignores drafts, fully paid invoices and not-yet-due invoices; a part-paid one still counts, with the right amount due", async () => {
      const rule = await makeRule(owner, { trigger: "INVOICE_OVERDUE", triggerParams: { days: 1 }, action: notify, conditions: [{ field: "amount_due", operator: "gt", value: "500.00" }] });
      await InvoiceService.create(owner, {
        customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-10"), currency, arAccountId: sales.arAccountId,
        lines: [{ description: "draft", quantity: "1", unitPrice: "900.00", accountId: sales.revenueAccountId }],
      });
      const paid = await approvedInvoice("2026-01-10");
      await PaymentAllocationService.recordPayment(owner, { customerContactId: sales.customerContactId, paymentDate: new Date("2026-01-12"), amount: "1100.00", currency, method: "BANK_TRANSFER", depositAccountId: sales.bankGlAccountId, allocations: [{ invoiceId: paid.id, amount: "1100.00" }] });
      const part = await approvedInvoice("2026-01-10");
      await PaymentAllocationService.recordPayment(owner, { customerContactId: sales.customerContactId, paymentDate: new Date("2026-01-12"), amount: "100.00", currency, method: "BANK_TRANSFER", depositAccountId: sales.bankGlAccountId, allocations: [{ invoiceId: part.id, amount: "100.00" }] });
      await approvedInvoice("2026-03-31"); // not due yet
      await approvedInvoice("2026-01-10", "0.40"); // total 4.40: below the amount_due condition

      await pass("2026-02-01T10:00:00Z");
      const runs = await runsOf(orgId, rule);
      expect(runs.map((r) => r.jobKey)).toEqual([`invoice:${part.id}:overdue:1`]);
      const job = (await jobsOf(orgId, rule))[0]!;
      expect((job.context as { amountDue: string; facts: Record<string, unknown> }).amountDue).toBe("1000.00");
      expect((job.context as { facts: Record<string, unknown> }).facts).toMatchObject({ days_overdue: 22, currency: "AUD" });
    });

    it("a scan is bounded: more than the per-pass cap of matches are picked up over successive passes, none twice", async () => {
      const rule = await makeRule(owner, { trigger: "INVOICE_OVERDUE", triggerParams: { days: 1 }, action: notify });
      for (let i = 0; i < 12; i += 1) await approvedInvoice("2026-01-10");
      const first = await pass("2026-02-01T10:00:00Z");
      expect(first.capped).toBe(true);
      expect(await runsOf(orgId, rule)).toHaveLength(10);
      await pass("2026-02-01T10:01:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(12);
      expect(new Set((await jobsOf(orgId, rule)).map((j) => j.jobKey)).size).toBe(12);
    });
  });

  describe("BILL_DUE_SOON", () => {
    it("fires once for a bill due within N days; not for a later, an already-overdue or a paid bill", async () => {
      const rule = await makeRule(owner, { trigger: "BILL_DUE_SOON", triggerParams: { days: 7 }, action: notify });
      const soon = await approvedBill("2026-02-15");
      await approvedBill("2026-03-30"); // too far
      await approvedBill("2026-02-01"); // already overdue (not "due soon")
      await pass("2026-02-10T10:00:00Z");
      expect((await runsOf(orgId, rule)).map((r) => r.jobKey)).toEqual([`bill:${soon.id}:due_soon:7`]);
      const context = (await jobsOf(orgId, rule))[0]!.context as { facts: Record<string, unknown>; amountDue: string };
      expect(context.facts.days_until_due).toBe(5);
      expect(context.amountDue).toBe("110.00");
      await pass("2026-02-11T10:00:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(1);
    });
  });

  describe("INVENTORY_BELOW_REORDER and CREATE_DRAFT_PURCHASE_ORDER", () => {
    const addStock = (quantity: string) =>
      InventoryAdjustmentService.create(owner, { productId: inventory.productId, quantityDelta: quantity, unitCost: "12.50", reason: "test", adjustmentAccountId: inventory.adjustmentAccountId });
    const setSupplier = async () => {
      const product = (await ProductService.get(owner, inventory.productId))!;
      await ProductService.update(owner, inventory.productId, {
        sku: product.sku, name: product.name, type: product.type, revenueAccountId: product.revenueAccountId, inventoryAssetAccountId: product.inventoryAssetAccountId ?? undefined,
        cogsAccountId: product.cogsAccountId ?? undefined, reorderPoint: product.reorderPoint ?? undefined, reorderQuantity: product.reorderQuantity ?? undefined, preferredSupplierContactId: purchases.supplierContactId,
      });
    };

    it("fires once while stock stays at or below the point, and RE-ARMS when it recovers above it", async () => {
      const rule = await makeRule(owner, { trigger: "INVENTORY_BELOW_REORDER", action: notify });
      await pass("2026-02-01T10:00:00Z"); // qty 0 <= 5
      await pass("2026-02-01T10:01:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(1);
      expect((await jobsOf(orgId, rule)).map((j) => j.jobKey)).toEqual([`reorder:${inventory.productId}`]);

      await addStock("3"); // 3 <= 5: still below, still armed-off
      await pass("2026-02-01T10:02:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(1);

      await addStock("10"); // 13 > 5: recovered
      const recovered = await pass("2026-02-01T10:03:00Z");
      expect(recovered.rearmed).toBe(1);
      expect(await jobsOf(orgId, rule)).toHaveLength(0);
      expect(await runsOf(orgId, rule)).toHaveLength(1);

      await InventoryAdjustmentService.create(owner, { productId: inventory.productId, quantityDelta: "-9", reason: "shrink", adjustmentAccountId: inventory.adjustmentAccountId }); // 4 <= 5 again
      await pass("2026-02-01T10:04:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(2); // fires a second time, after the re-arm
      await pass("2026-02-01T10:05:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(2);
    });

    it("exactly at the reorder point counts as below (matching the Reorder Alerts page); conditions on shortfall gate", async () => {
      const gated = await makeRule(owner, { name: "big shortfall", trigger: "INVENTORY_BELOW_REORDER", action: notify, conditions: [{ field: "shortfall", operator: "gte", value: "5" }] });
      await addStock("5"); // exactly at the point: shortfall 0
      await pass("2026-02-01T10:00:00Z");
      expect(await runsOf(orgId, gated)).toHaveLength(0);
      await InventoryAdjustmentService.create(owner, { productId: inventory.productId, quantityDelta: "-5", reason: "sold", adjustmentAccountId: inventory.adjustmentAccountId }); // 0 -> shortfall 5
      await pass("2026-02-01T10:01:00Z");
      expect(await runsOf(orgId, gated)).toHaveLength(1);
    });

    it("drafts a flagged DRAFT purchase order for the preferred supplier at the reorder quantity - and nothing else", async () => {
      await setSupplier();
      const rule = await makeRule(owner, { name: "Auto reorder", trigger: "INVENTORY_BELOW_REORDER", action: { type: "CREATE_DRAFT_PURCHASE_ORDER" }, acknowledgeWriteAction: true });
      const ledgerBefore = JSON.stringify(await LedgerService.getTrialBalance(owner));
      const entriesBefore = (await withTenant(orgId, (tx) => tx.select().from(journalEntries))).length;

      await pass("2026-02-01T10:00:00Z");
      const runs = await runsOf(orgId, rule);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "SUCCESS", createdObjectType: "PurchaseOrder", actorType: "AUTOMATION" });

      const pos = await withTenant(orgId, (tx) => tx.select().from(purchaseOrders));
      expect(pos).toHaveLength(1);
      const po = pos[0]!;
      expect(po).toMatchObject({ id: runs[0]!.createdObjectId, status: "DRAFT", supplierContactId: purchases.supplierContactId, automationRuleId: rule, sentAt: null });
      expect(po.memo).toMatch(/Drafted by automation rule "Auto reorder"/);
      const lines = await withTenant(orgId, (tx) => tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id)));
      expect(lines).toHaveLength(1);
      expect(Number(lines[0]!.quantity)).toBe(20);
      expect(lines[0]!.accountId).toBe(inventory.inventoryAssetAccountId);
      expect(lines[0]!.quantityReceived).toBe("0.0000");
      // Nothing was posted, billed or sent: the ledger is exactly as before.
      expect(JSON.stringify(await LedgerService.getTrialBalance(owner))).toBe(ledgerBefore);
      expect((await withTenant(orgId, (tx) => tx.select().from(journalEntries))).length).toBe(entriesBefore);
      expect(await withTenant(orgId, (tx) => tx.select().from(bills))).toHaveLength(0);
      // Audited as AUTOMATION, by the PO service itself, with the rule and its authoriser.
      const audit = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "purchase_order.draft_created");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: "AUTOMATION", actorUserId: owner.userId });
      expect(audit[0]!.metadata).toMatchObject({ viaAutomation: true, automationRuleId: rule });
      // UNDO: it is an ordinary draft a person can delete.
      await PurchaseOrderService.deleteDraft(owner, po.id);
      expect(await withTenant(orgId, (tx) => tx.select().from(purchaseOrders))).toHaveLength(0);
      // ...and the run log still names it (the link simply no longer resolves).
      expect((await runsOf(orgId, rule))[0]!.createdObjectId).toBe(po.id);
    });

    it("the automation identity can DRAFT a purchase order but cannot send, convert, receive, cancel, close, edit or delete one", async () => {
      await setSupplier();
      const po = await PurchaseOrderService.create(owner, {
        supplierContactId: purchases.supplierContactId, issueDate: new Date("2026-02-01"), currency,
        lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: inventory.inventoryAssetAccountId }],
      });
      const identity = resolveExecutionIdentity({ id: "11111111-1111-4111-8111-111111111111", name: "r", organizationId: orgId, trigger: "INVENTORY_BELOW_REORDER", actionType: "CREATE_DRAFT_PURCHASE_ORDER" }, { userId: owner.userId, role: "OWNER", membershipActive: true, userDisabledAt: null });
      expect(identity.ok).toBe(true);
      const automation = (identity as { actor: Actor }).actor;
      expect(automation.type).toBe("AUTOMATION");
      expect([...(automation.grantedPermissions ?? [])].sort()).toEqual(["contact:read", "inventory:read", "product:read", "purchase_order:manage"]);
      await expect(PurchaseOrderService.markSent(automation, po.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.cancel(automation, po.id, "no")).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.close(automation, po.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.deleteDraft(automation, po.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.recordReceipt(automation, po.id, { receivedDate: new Date(), lines: [] })).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.convertToBill(automation, po.id, { apAccountId: purchases.apAccountId, issueDate: new Date(), dueDate: new Date(), lines: [] } as never)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PurchaseOrderService.update(automation, po.id, { supplierContactId: purchases.supplierContactId, issueDate: new Date(), currency, lines: [] } as never)).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("skips with a clear reason when the product has no preferred supplier, then drafts once that is fixed (a SKIPPED job re-arms)", async () => {
      const rule = await makeRule(owner, { trigger: "INVENTORY_BELOW_REORDER", action: { type: "CREATE_DRAFT_PURCHASE_ORDER" }, acknowledgeWriteAction: true });
      await pass("2026-02-01T10:00:00Z");
      const runs = await runsOf(orgId, rule);
      expect(runs.map((r) => r.outcome)).toEqual(["SKIPPED"]);
      expect(runs[0]!.reason).toMatch(/no preferred supplier/);
      expect(await withTenant(orgId, (tx) => tx.select().from(purchaseOrders))).toHaveLength(0);
      await pass("2026-02-01T10:01:00Z");
      expect(await runsOf(orgId, rule)).toHaveLength(1); // not repeated while unfixed

      await setSupplier();
      await pass("2026-02-01T10:02:00Z");
      expect((await runsOf(orgId, rule)).map((r) => r.outcome)).toEqual(["SKIPPED", "SUCCESS"]);
      expect(await withTenant(orgId, (tx) => tx.select().from(purchaseOrders))).toHaveLength(1);
      await pass("2026-02-01T10:03:00Z");
      expect(await withTenant(orgId, (tx) => tx.select().from(purchaseOrders))).toHaveLength(1); // once
    });

    it("creating a draft-PO rule needs the explicit acknowledgement, and the action is refused with any other trigger", async () => {
      await expect(makeRule(owner, { trigger: "INVENTORY_BELOW_REORDER", action: { type: "CREATE_DRAFT_PURCHASE_ORDER" } })).rejects.toThrow(/creates a record in your books/);
      await expect(makeRule(owner, { trigger: "invoice.created", action: { type: "CREATE_DRAFT_PURCHASE_ORDER" }, acknowledgeWriteAction: true })).rejects.toThrow(/cannot be used with this trigger/);
      const ok = await makeRule(owner, { trigger: "INVENTORY_BELOW_REORDER", action: { type: "CREATE_DRAFT_PURCHASE_ORDER" }, acknowledgeWriteAction: true });
      expect((await ruleRow(orgId, ok)).enabled).toBe(true);
    });
  });

  it("scan keys are never purged by the retention sweep (they are the 'already fired' memory)", async () => {
    const rule = await makeRule(owner, { trigger: "INVOICE_OVERDUE", triggerParams: { days: 1 }, action: notify });
    await approvedInvoice("2026-01-10");
    await pass("2026-02-01T10:00:00Z");
    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      await admin.query(`UPDATE automation_jobs SET created_at = now() - interval '400 days'`);
    } finally {
      await admin.end();
    }
    await pass("2026-02-01T11:00:00Z");
    await pass("2026-02-01T12:00:00Z");
    expect(await runsOf(orgId, rule)).toHaveLength(1);
    expect(await jobsOf(orgId, rule)).toHaveLength(1);
  });
});
