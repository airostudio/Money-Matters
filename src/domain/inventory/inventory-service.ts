import { and, desc, eq } from "drizzle-orm";
import { products, inventoryMovements } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { applyPurchase, applySale, assertWeightedAverage } from "./costing";
import { loadProductOr404 } from "./product-service";
import type { RecordPurchaseMovementInput, RecordSaleMovementInput, RecordedSaleMovement } from "./types";

/**
 * Mutates a `TRACKED_INVENTORY` product's perpetual stock state
 * (`quantityOnHand`/`averageUnitCost`) and appends the
 * `inventory_movements` audit row for it — the ONLY writer of either. Both
 * functions are called from inside `InvoiceService.approveAndPost` /
 * `BillService.approveAndPost` (and `InventoryAdjustmentService`), using
 * the SAME transaction those callers already hold — never a fresh
 * `withTenant` of their own — so a stock mutation and the journal entry it
 * accompanies always commit or roll back together.
 *
 * `SELECT ... FOR UPDATE` locks the product row for the rest of the
 * transaction, serializing two concurrent sales/purchases of the same
 * product so the weighted-average recomputation in `costing.ts` is never
 * read-modify-written against a stale balance.
 */
export const InventoryService = {
  /** Increases a product's quantity and recomputes its weighted-average cost from a purchase (a bill line). Does not post any journal lines itself — the bill's own existing debit, resolved onto `inventoryAssetAccountId`, already covers it. */
  async recordPurchase(tx: TenantDb, actor: Actor, input: RecordPurchaseMovementInput): Promise<void> {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .for("update");
    if (!product || product.organizationId !== actor.organizationId) {
      throw new Error(`Product ${input.productId} was not found in this organization.`);
    }
    assertWeightedAverage(product.costingMethod);

    const result = applyPurchase(
      { quantityOnHand: product.quantityOnHand, averageUnitCost: product.averageUnitCost },
      input.quantity,
      input.unitCost,
    );

    await tx
      .update(products)
      .set({
        quantityOnHand: result.quantityOnHand,
        averageUnitCost: result.averageUnitCost,
        updatedAt: new Date(),
      })
      .where(eq(products.id, product.id));

    await tx.insert(inventoryMovements).values({
      organizationId: actor.organizationId,
      productId: product.id,
      movementType: "PURCHASE",
      quantityDelta: input.quantity,
      unitCost: input.unitCost,
      totalValue: result.totalValue,
      balanceQuantityAfter: result.quantityOnHand,
      balanceAverageCostAfter: result.averageUnitCost,
      billLineId: input.billLineId,
      journalEntryId: input.journalEntryId ?? null,
      occurredAt: input.occurredAt,
      createdById: actor.userId,
    });
  },

  /**
   * Decreases a product's quantity, valued at the current weighted-average
   * cost, from a sale (an invoice line). Rejects (via
   * `InsufficientStockError`, propagated from `costing.ts`) an oversell.
   * Returns the COGS amount and accounts so `InvoiceService` can add the
   * debit/credit lines to the SAME journal entry as the sale's own
   * revenue/tax lines — this function never posts a journal itself.
   */
  async recordSale(tx: TenantDb, actor: Actor, input: RecordSaleMovementInput): Promise<RecordedSaleMovement> {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .for("update");
    if (!product || product.organizationId !== actor.organizationId) {
      throw new Error(`Product ${input.productId} was not found in this organization.`);
    }
    assertWeightedAverage(product.costingMethod);
    if (!product.inventoryAssetAccountId || !product.cogsAccountId) {
      throw new Error(`Product ${product.sku} is missing its inventory asset or COGS account.`);
    }

    const result = applySale(
      { quantityOnHand: product.quantityOnHand, averageUnitCost: product.averageUnitCost },
      input.quantity,
      product.sku,
    );

    await tx
      .update(products)
      .set({
        quantityOnHand: result.quantityOnHand,
        updatedAt: new Date(),
      })
      .where(eq(products.id, product.id));

    const [movement] = await tx
      .insert(inventoryMovements)
      .values({
        organizationId: actor.organizationId,
        productId: product.id,
        movementType: "SALE",
        quantityDelta: `-${input.quantity}`,
        unitCost: result.averageUnitCost,
        totalValue: result.totalValue,
        balanceQuantityAfter: result.quantityOnHand,
        balanceAverageCostAfter: result.averageUnitCost,
        invoiceLineId: input.invoiceLineId,
        occurredAt: input.occurredAt,
        createdById: actor.userId,
      })
      .returning({ id: inventoryMovements.id });
    if (!movement) throw new Error("Failed to record sale movement.");

    return {
      movementId: movement.id,
      cogsAmount: result.cogsAmount,
      cogsAccountId: product.cogsAccountId,
      inventoryAssetAccountId: product.inventoryAssetAccountId,
    };
  },

  /** Links a batch of movements to the journal entry that posted them, once that entry exists (purchase/sale movements are inserted before the bill/invoice's `postJournal` call returns an entry id). */
  async linkMovementsToJournalEntry(tx: TenantDb, movementIds: string[], journalEntryId: string): Promise<void> {
    for (const id of movementIds) {
      await tx.update(inventoryMovements).set({ journalEntryId }).where(eq(inventoryMovements.id, id));
    }
  },

  /** The movement history for one product, newest first — the audit trail behind its current `quantityOnHand`/`averageUnitCost`. Read-only, for display (e.g. the product detail page). */
  async listMovements(actor: Actor, productId: string) {
    assertPermission(actor, "inventory:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.organizationId, actor.organizationId), eq(inventoryMovements.productId, productId)))
        .orderBy(desc(inventoryMovements.createdAt)),
    );
  },
};

export { loadProductOr404 };
