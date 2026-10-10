import type { inventoryCostingMethodEnum, inventoryMovementTypeEnum, productTypeEnum } from "@/db/schema";

export type ProductType = (typeof productTypeEnum.enumValues)[number];
export type InventoryCostingMethod = (typeof inventoryCostingMethodEnum.enumValues)[number];
export type InventoryMovementType = (typeof inventoryMovementTypeEnum.enumValues)[number];

export interface CreateProductInput {
  sku: string;
  name: string;
  description?: string;
  type: ProductType;
  /** Decimal string. Convenience prefill only — never authoritative over a typed invoice-line price. */
  sellPrice?: string;
  /** Always required — credited when any invoice line sells this product. */
  revenueAccountId: string;
  /** Required for NON_INVENTORY/SERVICE, ignored for TRACKED_INVENTORY. */
  purchaseAccountId?: string;
  /** Required for TRACKED_INVENTORY, ignored otherwise. */
  inventoryAssetAccountId?: string;
  /** Required for TRACKED_INVENTORY, ignored otherwise. */
  cogsAccountId?: string;
  /** Decimal string. Null/omitted means "never alert" for this product. */
  reorderPoint?: string;
  reorderQuantity?: string;
  preferredSupplierContactId?: string;
}

export type UpdateProductInput = CreateProductInput;

export interface RecordPurchaseMovementInput {
  productId: string;
  /** Decimal string. Must be positive. */
  quantity: string;
  /** Decimal string — the purchase line's own unit price, used as this movement's unit cost. */
  unitCost: string;
  billLineId: string;
  occurredAt: Date;
  /** The bill's own posted journal entry, when already known at call time (it always is — the bill posts before its lines' movements are recorded). */
  journalEntryId?: string;
}

export interface RecordSaleMovementInput {
  productId: string;
  /** Decimal string. Must be positive. */
  quantity: string;
  invoiceLineId: string;
  occurredAt: Date;
}

export interface RecordedSaleMovement {
  movementId: string;
  /** Decimal string — quantity × the weighted-average cost at the moment of sale. The COGS debit / inventory-asset credit amount. */
  cogsAmount: string;
  cogsAccountId: string;
  inventoryAssetAccountId: string;
}

export interface CreateInventoryAdjustmentInput {
  productId: string;
  /** Decimal string, signed: positive increases on-hand quantity, negative decreases it. */
  quantityDelta: string;
  /** Required for an increasing adjustment (the cost to value the added stock at). Ignored for a decreasing adjustment, which is always valued at the current weighted-average cost. */
  unitCost?: string;
  reason: string;
  adjustmentAccountId: string;
  occurredAt?: Date;
}

export interface ProductValuationRow {
  productId: string;
  sku: string;
  name: string;
  quantityOnHand: string;
  averageUnitCost: string;
  /** quantityOnHand × averageUnitCost. */
  value: string;
  inventoryAssetAccountId: string;
}

export interface InventoryAssetAccountReconciliation {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Sum of `quantityOnHand × averageUnitCost` across every tracked product posting to this account. */
  valuationTotal: string;
  /** This account's own posted GL balance (normal-signed; an ASSET's debit balance). */
  glBalance: string;
  /** `valuationTotal - glBalance`. Non-zero means a real bug — see this report's own doc comment. */
  difference: string;
  reconciled: boolean;
}

export interface InventoryValuationReport {
  currency: string;
  products: ProductValuationRow[];
  totalValuation: string;
  reconciliation: InventoryAssetAccountReconciliation[];
  /** True only when every `reconciliation` row's `reconciled` is true. */
  fullyReconciled: boolean;
}

export interface ReorderAlertRow {
  productId: string;
  sku: string;
  name: string;
  quantityOnHand: string;
  reorderPoint: string;
  reorderQuantity: string | null;
  preferredSupplierContactId: string | null;
}
