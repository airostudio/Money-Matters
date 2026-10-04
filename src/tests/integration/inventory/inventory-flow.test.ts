import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createInventoryFixtures } from "../../helpers/inventory";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createSalesFixtures } from "../../helpers/sales";
import { BillService } from "@/domain/purchases/bill-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { ProductService } from "@/domain/inventory/product-service";
import { InventoryAdjustmentService } from "@/domain/inventory/inventory-adjustment-service";
import { InventoryValuationService } from "@/domain/inventory/valuation-service";
import { ReorderAlertService } from "@/domain/inventory/reorder-alert-service";
import { InsufficientStockError } from "@/domain/inventory/errors";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Inventory — full flow (Phase 7 Slice 2)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let baseCurrency: string;
  let inv: Awaited<ReturnType<typeof createInventoryFixtures>>;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("inventory-flow");
    owner = org.owner;
    baseCurrency = org.baseCurrency;
    inv = await createInventoryFixtures(owner, baseCurrency);
    sales = await createSalesFixtures(owner, baseCurrency);
    purchases = await createPurchasesFixtures(owner, baseCurrency);
  });

  async function buyStock(quantity: string, unitCost: string) {
    const bill = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-01-05"),
      dueDate: new Date("2026-02-04"),
      currency: baseCurrency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Buy widgets", quantity, unitPrice: unitCost, productId: inv.productId }],
    });
    return BillService.approveAndPost(owner, bill.id);
  }

  async function sellStock(quantity: string, unitPrice: string) {
    const invoice = await InvoiceService.create(owner, {
      customerContactId: sales.customerContactId,
      issueDate: new Date("2026-01-10"),
      dueDate: new Date("2026-02-09"),
      currency: baseCurrency,
      arAccountId: sales.arAccountId,
      lines: [{ description: "Sell widgets", quantity, unitPrice, productId: inv.productId }],
    });
    return InvoiceService.approveAndPost(owner, invoice.id);
  }

  it("creates a TRACKED_INVENTORY product requiring both an inventory asset and a COGS account", async () => {
    const product = await ProductService.get(owner, inv.productId);
    expect(product!.type).toBe("TRACKED_INVENTORY");
    expect(product!.inventoryAssetAccountId).toBe(inv.inventoryAssetAccountId);
    expect(product!.cogsAccountId).toBe(inv.cogsAccountId);
    expect(product!.quantityOnHand).toBe("0.0000");
  });

  it("buying stock via a bill increases quantity and sets the weighted-average cost", async () => {
    await buyStock("10", "5.00");
    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("10.0000");
    expect(product!.averageUnitCost).toBe("5.0000");

    // The bill's own posting already debited the inventory asset account —
    // no separate posting process for a purchase.
    const trialBalance = await LedgerService.getTrialBalance(owner);
    const assetRow = trialBalance.find((r) => r.accountId === inv.inventoryAssetAccountId);
    expect(assetRow!.balance).toBe("50.0000");
  });

  it("a second purchase at a different cost recomputes the weighted average", async () => {
    await buyStock("10", "5.00");
    await buyStock("10", "7.00");
    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("20.0000");
    expect(product!.averageUnitCost).toBe("6.0000"); // (50 + 70) / 20
  });

  it("selling stock via an invoice decreases quantity and posts COGS in the SAME journal as the sale", async () => {
    await buyStock("10", "5.00");
    const posted = await sellStock("4", "20.00");

    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("6.0000");
    expect(product!.averageUnitCost).toBe("5.0000"); // unchanged by a sale

    // Revenue (80), COGS (20) and the inventory-asset credit (20) are all
    // lines on this ONE journal entry — not a separate disconnected process.
    const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
    expect(entry!.lines.length).toBeGreaterThanOrEqual(3);
    const cogsLine = entry!.lines.find((l) => l.accountId === inv.cogsAccountId);
    const assetCreditLine = entry!.lines.find(
      (l) => l.accountId === inv.inventoryAssetAccountId && Number(l.credit) > 0,
    );
    expect(cogsLine!.debit).toBe("20.0000"); // 4 @ 5.00 average cost
    expect(assetCreditLine!.credit).toBe("20.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const assetRow = trialBalance.find((r) => r.accountId === inv.inventoryAssetAccountId);
    expect(assetRow!.balance).toBe("30.0000"); // 50 - 20
  });

  it("revenue and COGS both land correctly on the P&L, so gross margin is correct", async () => {
    await buyStock("10", "5.00");
    await sellStock("4", "20.00"); // revenue 80, COGS 20 -> gross margin 60

    const pnl = await ReportingService.getProfitAndLoss(owner, {
      from: new Date("2026-01-01"),
      to: new Date("2026-01-31"),
    });
    expect(pnl.totalRevenue).toBe("80.0000");
    expect(pnl.totalExpenses).toBe("20.0000");
    expect(pnl.netProfit).toBe("60.0000");
  });

  it("rejects a sale that would take quantity negative, with a clear error, and posts nothing", async () => {
    await buyStock("5", "5.00");

    await expect(sellStock("10", "20.00")).rejects.toThrow(InsufficientStockError);

    // Nothing was posted — quantity and the ledger are both untouched by
    // the rejected attempt.
    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("5.0000");
    const trialBalance = await LedgerService.getTrialBalance(owner);
    const revenueRow = trialBalance.find((r) => r.accountId === inv.revenueAccountId);
    expect(revenueRow?.balance ?? "0.0000").toBe("0.0000");
  });

  it("allows a sale that exactly exhausts on-hand stock", async () => {
    await buyStock("5", "5.00");
    await sellStock("5", "20.00");
    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("0.0000");
  });

  it("a manual adjustment (shrinkage) posts a journal and reduces quantity", async () => {
    await buyStock("10", "5.00");

    const adjustment = await InventoryAdjustmentService.create(owner, {
      productId: inv.productId,
      quantityDelta: "-2",
      reason: "Stocktake found 2 units damaged",
      adjustmentAccountId: inv.adjustmentAccountId,
    });
    expect(adjustment.journalEntryId).toBeTruthy();

    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("8.0000");

    const entry = await LedgerService.getJournalEntry(owner, adjustment.journalEntryId!);
    const shrinkDebit = entry!.lines.find((l) => l.accountId === inv.adjustmentAccountId);
    const assetCredit = entry!.lines.find((l) => l.accountId === inv.inventoryAssetAccountId);
    expect(shrinkDebit!.debit).toBe("10.0000"); // 2 @ 5.00
    expect(assetCredit!.credit).toBe("10.0000");
  });

  it("an increasing adjustment (stock found) posts the opposite entries", async () => {
    await buyStock("10", "5.00");

    const adjustment = await InventoryAdjustmentService.create(owner, {
      productId: inv.productId,
      quantityDelta: "3",
      unitCost: "5.00",
      reason: "Stocktake found extra stock",
      adjustmentAccountId: inv.adjustmentAccountId,
    });

    const product = await ProductService.get(owner, inv.productId);
    expect(product!.quantityOnHand).toBe("13.0000");

    const entry = await LedgerService.getJournalEntry(owner, adjustment.journalEntryId!);
    const assetDebit = entry!.lines.find((l) => l.accountId === inv.inventoryAssetAccountId);
    expect(assetDebit!.debit).toBe("15.0000"); // 3 @ 5.00
  });

  it("requires a reason for an adjustment", async () => {
    await buyStock("10", "5.00");
    await expect(
      InventoryAdjustmentService.create(owner, {
        productId: inv.productId,
        quantityDelta: "-1",
        reason: "   ",
        adjustmentAccountId: inv.adjustmentAccountId,
      }),
    ).rejects.toThrow();
  });

  it("inventory valuation reconciles exactly to the GL inventory asset account balance across purchases, sales and adjustments", async () => {
    await buyStock("10", "5.00"); // +10 @5 = 50
    await buyStock("10", "7.00"); // +10 @7 = 70, avg now 6.00, qty 20
    await sellStock("4", "20.00"); // -4 @6 = -24, qty 16, value 96
    await InventoryAdjustmentService.create(owner, {
      productId: inv.productId,
      quantityDelta: "-2",
      reason: "shrinkage",
      adjustmentAccountId: inv.adjustmentAccountId,
    }); // -2 @6 = -12, qty 14, value 84

    const report = await InventoryValuationService.getValuationReport(owner);
    const row = report.products.find((p) => p.productId === inv.productId)!;
    expect(row.quantityOnHand).toBe("14.0000");
    expect(row.averageUnitCost).toBe("6.0000");
    expect(row.value).toBe("84.0000");

    const reconciliation = report.reconciliation.find((r) => r.accountId === inv.inventoryAssetAccountId)!;
    expect(reconciliation.glBalance).toBe("84.0000");
    expect(reconciliation.difference).toBe("0.0000");
    expect(reconciliation.reconciled).toBe(true);
    expect(report.fullyReconciled).toBe(true);
  });

  it("reorder alerting flags only products at or below their reorder point", async () => {
    // Fixture product has reorderPoint = 5.00.
    await buyStock("3", "5.00"); // on hand 3, below reorder point of 5

    const alerts = await ReorderAlertService.list(owner);
    expect(alerts.some((a) => a.productId === inv.productId)).toBe(true);

    await buyStock("10", "5.00"); // now 13, above reorder point
    const alertsAfter = await ReorderAlertService.list(owner);
    expect(alertsAfter.some((a) => a.productId === inv.productId)).toBe(false);
  });

  it("deactivating a product is reflected, and it can be reactivated", async () => {
    await ProductService.setActive(owner, inv.productId, false);
    const inactive = await ProductService.get(owner, inv.productId);
    expect(inactive!.isActive).toBe(false);

    await ProductService.setActive(owner, inv.productId, true);
    const active = await ProductService.get(owner, inv.productId);
    expect(active!.isActive).toBe(true);
  });

  it("refuses to void a posted invoice that sold a tracked-inventory product", async () => {
    await buyStock("10", "5.00");
    const posted = await sellStock("4", "20.00");
    const { InvoiceService: Svc } = await import("@/domain/sales/invoice-service");
    await expect(Svc.voidInvoice(owner, posted.id, "test void")).rejects.toThrow();
  });

  it("refuses to void a posted bill that bought a tracked-inventory product", async () => {
    const posted = await buyStock("10", "5.00");
    await expect(BillService.voidBill(owner, posted.id, "test void")).rejects.toThrow();
  });
});
