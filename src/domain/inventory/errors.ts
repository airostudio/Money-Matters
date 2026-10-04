export class ProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`Product ${productId} was not found in this organization.`);
    this.name = "ProductNotFoundError";
  }
}

export class ProductSkuInUseError extends Error {
  constructor(sku: string) {
    super(`SKU "${sku}" is already in use in this organization.`);
    this.name = "ProductSkuInUseError";
  }
}

export class ProductInactiveError extends Error {
  constructor(sku: string) {
    super(`Product ${sku} is inactive and cannot be bought or sold.`);
    this.name = "ProductInactiveError";
  }
}

export class InvalidProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProductError";
  }
}

/**
 * Thrown by `ProductService.create`/`update` when the accounts required for
 * a product's `type` aren't all supplied — see `products`' doc comment in
 * src/db/schema.ts for exactly which accounts each type requires.
 */
export class MissingProductAccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingProductAccountsError";
  }
}

/**
 * A sale (or a decreasing adjustment) would take `product`'s on-hand
 * quantity negative. No backorder support in this slice — see
 * docs/roadmap.md — so this is always refused outright, never silently
 * allowed or queued.
 */
export class InsufficientStockError extends Error {
  constructor(sku: string, available: string, requested: string) {
    super(
      `Insufficient stock for ${sku}: ${available} on hand, ${requested} requested. ` +
        `Backorders are not supported — reduce the quantity or restock first.`,
    );
    this.name = "InsufficientStockError";
  }
}

/**
 * Thrown when an invoice/bill line carries a `productId` for a currency
 * other than the organization's base currency. Multi-currency inventory
 * costing is deferred this slice — see docs/roadmap.md — so a tracked
 * product can only be bought/sold in the org's base currency.
 */
export class ProductCurrencyMismatchError extends Error {
  constructor(sku: string, lineCurrency: string, baseCurrency: string) {
    super(
      `Product ${sku} is tracked inventory and can only be bought or sold in the ` +
        `organization's base currency (${baseCurrency}), not ${lineCurrency}. ` +
        `Multi-currency inventory costing is not supported in this slice.`,
    );
    this.name = "ProductCurrencyMismatchError";
  }
}

export class InvalidInventoryAdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInventoryAdjustmentError";
  }
}

/**
 * Voiding a posted invoice/bill that has any `TRACKED_INVENTORY` line is
 * refused in this slice — correctly reversing both the weighted-average
 * cost history and the quantity a later movement may already have
 * consumed/built on needs either a correcting movement scheme or full
 * history replay, which is deferred (see docs/roadmap.md). Use a manual
 * `InventoryAdjustmentService` correction for the stock, and consult an
 * accountant for the revenue/COGS reversal, in the meantime.
 */
export class VoidWouldDesyncInventoryError extends Error {
  constructor(documentNumber: string) {
    super(
      `${documentNumber} has one or more inventory-tracked lines — voiding it is not ` +
        `supported in this slice, since correctly reversing the weighted-average cost ` +
        `history it may have built on is deferred. Use a manual inventory adjustment ` +
        `to correct stock, and consult an accountant for the revenue/COGS reversal.`,
    );
    this.name = "VoidWouldDesyncInventoryError";
  }
}
