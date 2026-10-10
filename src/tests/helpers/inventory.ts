import { AccountService } from "@/domain/accounts/account-service";
import { ProductService } from "@/domain/inventory/product-service";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use chart of accounts + a TRACKED_INVENTORY product for
 * inventory tests — the inventory-side mirror of
 * `src/tests/helpers/sales.ts`/`purchases.ts`. Account codes are suffixed
 * with a counter so this can be called more than once against the same
 * organization without colliding on the org-unique code index.
 */
export async function createInventoryFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const inventoryAssetAccount = await AccountService.create(actor, {
    code: `INV-${suffix}`,
    name: "Inventory Asset",
    type: "ASSET",
    currency,
  });
  const cogsAccount = await AccountService.create(actor, {
    code: `COGS-${suffix}`,
    name: "Cost of Goods Sold",
    type: "EXPENSE",
    currency,
  });
  const revenueAccount = await AccountService.create(actor, {
    code: `PRODREV-${suffix}`,
    name: "Product Sales Revenue",
    type: "REVENUE",
    currency,
  });
  const adjustmentAccount = await AccountService.create(actor, {
    code: `SHRINK-${suffix}`,
    name: "Inventory Shrinkage",
    type: "EXPENSE",
    currency,
  });

  const product = await ProductService.create(actor, {
    sku: `SKU-${suffix}`,
    name: "Widget",
    type: "TRACKED_INVENTORY",
    revenueAccountId: revenueAccount.id,
    inventoryAssetAccountId: inventoryAssetAccount.id,
    cogsAccountId: cogsAccount.id,
    reorderPoint: "5.00",
    reorderQuantity: "20.00",
  });

  return {
    inventoryAssetAccountId: inventoryAssetAccount.id,
    cogsAccountId: cogsAccount.id,
    revenueAccountId: revenueAccount.id,
    adjustmentAccountId: adjustmentAccount.id,
    productId: product.id,
    sku: product.sku,
  };
}
