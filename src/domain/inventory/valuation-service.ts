import { eq } from "drizzle-orm";
import { organizations, products } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { sumPostedActivityByAccount } from "@/domain/ledger/gl-aggregation";
import { normalSignedBalance } from "@/domain/reporting/financial-statements";
import type { InventoryAssetAccountReconciliation, InventoryValuationReport, ProductValuationRow } from "./types";

/**
 * Inventory Valuation report (master spec §20): total on-hand quantity ×
 * weighted-average cost per `TRACKED_INVENTORY` product, and in aggregate,
 * **reconciled against the inventory asset account's own posted GL
 * balance** — same spirit as Phase 5's Balance Sheet equation check
 * (`src/domain/reporting/financial-statements.ts`'s `balanceCheck`). Since
 * every purchase/sale/adjustment in this slice posts its inventory-asset
 * debit/credit through `PostingService` in lockstep with the matching
 * `InventoryService`/`InventoryAdjustmentService` quantity mutation (see
 * those modules' doc comments), the two numbers are two independent paths
 * to the same fact and should always agree exactly. A non-zero
 * `difference` on any account here is never "rounding" — it is a real bug
 * (a movement posted without its matching journal line, or vice versa) and
 * this report surfaces it rather than silently reporting one number and
 * hiding the mismatch, the same discipline that report's own doc comment
 * describes.
 */
export const InventoryValuationService = {
  async getValuationReport(actor: Actor, asOfDate: Date = new Date()): Promise<InventoryValuationReport> {
    assertPermission(actor, "inventory:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.organizationId));
      const currency = org?.baseCurrency ?? "AUD";

      const trackedProducts = await tx
        .select()
        .from(products)
        .where(eq(products.organizationId, actor.organizationId));
      const tracked = trackedProducts.filter((p) => p.type === "TRACKED_INVENTORY");

      const productRows: ProductValuationRow[] = tracked.map((p) => {
        const value = Money.of(p.quantityOnHand, currency).multiply(p.averageUnitCost);
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantityOnHand: p.quantityOnHand,
          averageUnitCost: p.averageUnitCost,
          value: value.toString(),
          inventoryAssetAccountId: p.inventoryAssetAccountId!,
        };
      });

      const totalValuation = productRows.reduce(
        (sum, r) => sum.add(Money.of(r.value, currency)),
        Money.zero(currency),
      );

      // Group by inventory asset account: several products may legitimately
      // share one (e.g. a single "Inventory" asset account for the whole
      // catalog), so the reconciliation is per-account, not per-product.
      const valuationByAccount = new Map<string, Money>();
      for (const row of productRows) {
        const running = valuationByAccount.get(row.inventoryAssetAccountId) ?? Money.zero(currency);
        valuationByAccount.set(row.inventoryAssetAccountId, running.add(Money.of(row.value, currency)));
      }

      const glRows = await sumPostedActivityByAccount(tx, actor.organizationId, { to: asOfDate });
      const glByAccount = new Map(glRows.map((r) => [r.accountId, r]));

      const reconciliation: InventoryAssetAccountReconciliation[] = [...valuationByAccount.entries()].map(
        ([accountId, valuationTotal]) => {
          const glRow = glByAccount.get(accountId);
          const glBalance = glRow ? normalSignedBalance(glRow, currency) : Money.zero(currency);
          const difference = valuationTotal.subtract(glBalance);
          return {
            accountId,
            accountCode: glRow?.code ?? "",
            accountName: glRow?.name ?? "",
            valuationTotal: valuationTotal.toString(),
            glBalance: glBalance.toString(),
            difference: difference.toString(),
            reconciled: difference.isZero(),
          };
        },
      );

      return {
        currency,
        products: productRows,
        totalValuation: totalValuation.toString(),
        reconciliation,
        fullyReconciled: reconciliation.every((r) => r.reconciled),
      };
    });
  },
};
