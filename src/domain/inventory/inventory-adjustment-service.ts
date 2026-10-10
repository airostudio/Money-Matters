import { and, desc, eq } from "drizzle-orm";
import { inventoryAdjustments, inventoryMovements, products } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import { organizations } from "@/db/schema";
import { applyAdjustment, assertWeightedAverage } from "./costing";
import { InvalidInventoryAdjustmentError, InvalidProductError } from "./errors";
import { loadProductOr404 } from "./product-service";
import type { CreateInventoryAdjustmentInput } from "./types";

/**
 * Manual corrections to a `TRACKED_INVENTORY` product's quantity —
 * stocktake correction, damage, shrinkage (master spec §20's generic
 * adjustment workflow; a dedicated damaged-stock flow and a formal
 * stock-take/cycle-count workflow are both deferred, see
 * docs/roadmap.md). Every adjustment requires a `reason`, is audited, and
 * posts its own small balanced journal through `PostingService` exactly
 * like every other mutation in this codebase — never a quantity edit with
 * no ledger effect.
 */
export const InventoryAdjustmentService = {
  async list(actor: Actor, productId?: string) {
    assertPermission(actor, "inventory:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(inventoryAdjustments.organizationId, actor.organizationId)];
      if (productId) conditions.push(eq(inventoryAdjustments.productId, productId));
      return tx
        .select()
        .from(inventoryAdjustments)
        .where(and(...conditions))
        .orderBy(desc(inventoryAdjustments.occurredAt));
    });
  },

  async create(actor: Actor, input: CreateInventoryAdjustmentInput) {
    assertPermission(actor, "inventory:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (!input.reason.trim()) {
        throw new InvalidInventoryAdjustmentError("A reason is required for every inventory adjustment.");
      }

      const product = await loadProductOr404(tx, actor.organizationId, input.productId);
      if (product.type !== "TRACKED_INVENTORY") {
        throw new InvalidProductError(`${product.sku} is not a tracked-inventory product — nothing to adjust.`);
      }
      assertWeightedAverage(product.costingMethod);
      if (!product.inventoryAssetAccountId) {
        throw new Error(`Product ${product.sku} is missing its inventory asset account.`);
      }

      const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.organizationId));
      const currency = org?.baseCurrency ?? "AUD";

      // Lock the product row for the rest of this transaction — same
      // reasoning as InventoryService.recordPurchase/recordSale.
      const [lockedProduct] = await tx
        .select()
        .from(products)
        .where(eq(products.id, product.id))
        .for("update");
      if (!lockedProduct) throw new Error(`Product ${product.id} disappeared mid-transaction.`);

      const result = applyAdjustment(
        { quantityOnHand: lockedProduct.quantityOnHand, averageUnitCost: lockedProduct.averageUnitCost },
        input.quantityDelta,
        lockedProduct.sku,
        input.unitCost,
      );

      const occurredAt = input.occurredAt ?? new Date();
      const value = Money.of(result.totalValue, currency);

      // Positive delta (stock found) debits the inventory asset and credits
      // the adjustment account (e.g. "Other Income"/a contra-expense); a
      // negative delta (shrinkage/damage) debits the adjustment expense
      // account and credits inventory asset — the standard double-entry for
      // a perpetual-inventory write-up/write-down.
      const journalLines: JournalLineDraft[] = value.isPositive()
        ? [
            { accountId: product.inventoryAssetAccountId, debit: value.toString(), currency },
            { accountId: input.adjustmentAccountId, credit: value.toString(), currency },
          ]
        : [
            { accountId: input.adjustmentAccountId, debit: value.negate().toString(), currency },
            { accountId: product.inventoryAssetAccountId, credit: value.negate().toString(), currency },
          ];

      const [created] = await tx
        .insert(inventoryAdjustments)
        .values({
          organizationId: actor.organizationId,
          productId: product.id,
          quantityDelta: input.quantityDelta,
          unitCost: result.unitCostUsed,
          reason: input.reason.trim(),
          adjustmentAccountId: input.adjustmentAccountId,
          occurredAt,
          createdById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create inventory adjustment.");

      await tx
        .update(products)
        .set({
          quantityOnHand: result.quantityOnHand,
          averageUnitCost: result.averageUnitCost,
          updatedAt: new Date(),
        })
        .where(eq(products.id, product.id));

      const posted = await PostingService.postJournal(actor, {
        postingDate: occurredAt,
        memo: `Inventory adjustment: ${product.sku} — ${input.reason.trim()}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      await tx
        .update(inventoryAdjustments)
        .set({ journalEntryId: posted.entryId })
        .where(eq(inventoryAdjustments.id, created.id));

      await tx.insert(inventoryMovements).values({
        organizationId: actor.organizationId,
        productId: product.id,
        movementType: "ADJUSTMENT",
        quantityDelta: input.quantityDelta,
        unitCost: result.unitCostUsed,
        totalValue: result.totalValue,
        balanceQuantityAfter: result.quantityOnHand,
        balanceAverageCostAfter: result.averageUnitCost,
        adjustmentId: created.id,
        journalEntryId: posted.entryId,
        memo: input.reason.trim(),
        occurredAt,
        createdById: actor.userId,
      });

      await AuditService.record(tx, actor, {
        action: "inventory_adjustment.created",
        entityType: "InventoryAdjustment",
        entityId: created.id,
        after: {
          sku: product.sku,
          quantityDelta: input.quantityDelta,
          reason: input.reason.trim(),
          journalEntryId: posted.entryId,
        },
      });

      return { ...created, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },
};
