import Decimal from "decimal.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { products } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { ReorderAlertRow } from "./types";

/**
 * The one piece of master spec §21 "Inventory Intelligence" that's cheaply
 * real without a forecasting model: a deterministic "below reorder point"
 * list, `quantityOnHand <= reorderPoint`, for active `TRACKED_INVENTORY`
 * products with a reorder point set. There is deliberately no "likely to
 * reach zero stock in approximately N days" prediction here — that needs
 * real sales-velocity forecasting (a trend over historical SALE movements,
 * seasonality, lead time), which is a materially bigger feature and is
 * explicitly deferred rather than faked with a guessed number — see
 * docs/roadmap.md.
 */
export const ReorderAlertService = {
  async list(actor: Actor): Promise<ReorderAlertRow[]> {
    assertPermission(actor, "inventory:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, actor.organizationId),
            eq(products.type, "TRACKED_INVENTORY"),
            eq(products.isActive, true),
            isNotNull(products.reorderPoint),
          ),
        );

      return rows
        .filter((p) => new Decimal(p.quantityOnHand).lessThanOrEqualTo(new Decimal(p.reorderPoint!)))
        .map((p) => ({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantityOnHand: p.quantityOnHand,
          reorderPoint: p.reorderPoint!,
          reorderQuantity: p.reorderQuantity,
          preferredSupplierContactId: p.preferredSupplierContactId,
        }));
    });
  },
};
