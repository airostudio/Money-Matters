import Decimal from "decimal.js";
import { InsufficientStockError, InvalidProductError } from "./errors";

/**
 * Pure, DB-free weighted-average costing math (master spec §20) — the
 * inventory-side mirror of `src/domain/sales/invoice-calculations.ts`: no
 * database access, exercised directly by unit tests against hand-computed
 * inputs. Every amount is a `decimal.js` value from the moment it's parsed,
 * never a floating-point intermediate, per docs/accounting-engine.md §4 —
 * this applies to *quantities* here too, not just money, since a fractional
 * quantity (e.g. 2.5 kg) needs the same exactness a dollar amount does.
 *
 * Only the weighted-average method is implemented. FIFO (master spec §20)
 * is deliberately deferred rather than half-built alongside it — see
 * `inventoryCostingMethodEnum`'s doc comment in src/db/schema.ts for why
 * that's an enum (not a boolean) specifically so FIFO can be added later as
 * a new value with no restructuring. `assertWeightedAverage` is the one
 * place that enum is checked before any of the functions below run, so a
 * product somehow carrying an unsupported method fails loudly here rather
 * than silently computing nonsense.
 */

export interface StockState {
  /** Decimal string. */
  quantityOnHand: string;
  /** Decimal string. */
  averageUnitCost: string;
}

export interface PurchaseResult extends StockState {
  /** This movement's totalValue: quantity × unitCost, decimal string. */
  totalValue: string;
}

export interface SaleResult extends StockState {
  /** quantity × the PRE-sale weighted-average cost — the COGS amount, decimal string. */
  cogsAmount: string;
  /** Negative of cogsAmount — this movement's signed totalValue, decimal string. */
  totalValue: string;
}

export interface AdjustmentResult extends StockState {
  /** Signed decimal string: positive for an increasing adjustment, negative for a decreasing one. */
  totalValue: string;
  /** The unit cost this adjustment was valued at (the caller's for an increase, the pre-adjustment average for a decrease). */
  unitCostUsed: string;
}

export function assertWeightedAverage(costingMethod: string): void {
  if (costingMethod !== "WEIGHTED_AVERAGE") {
    throw new InvalidProductError(
      `Unsupported costing method "${costingMethod}" — only WEIGHTED_AVERAGE is implemented in this slice.`,
    );
  }
}

function parsePositiveQuantity(value: string, label: string): Decimal {
  if (value === undefined || value === null || value.trim() === "") {
    throw new InvalidProductError(`${label} is required.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new InvalidProductError(`${label} must be a plain decimal number.`);
  }
  const decimal = new Decimal(value.trim());
  if (decimal.isZero() || decimal.isNegative()) {
    throw new InvalidProductError(`${label} must be greater than zero.`);
  }
  return decimal;
}

function parseDecimal(value: string, label: string): Decimal {
  if (value === undefined || value === null || value.trim() === "") {
    throw new InvalidProductError(`${label} is required.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new InvalidProductError(`${label} must be a plain decimal number.`);
  }
  return new Decimal(value.trim());
}

/**
 * Applies a purchase: on-hand quantity increases by `quantity`, and the
 * weighted-average unit cost is recomputed as
 * `(oldQty × oldAvgCost + quantity × unitCost) / (oldQty + quantity)` — the
 * textbook perpetual weighted-average formula. Called on every bill line
 * that buys a `TRACKED_INVENTORY` product (`InventoryService.recordPurchase`),
 * and by an increasing `InventoryAdjustmentService` correction.
 */
export function applyPurchase(state: StockState, quantity: string, unitCost: string): PurchaseResult {
  const purchaseQty = parsePositiveQuantity(quantity, "Quantity");
  const purchaseUnitCost = parseDecimal(unitCost, "Unit cost");
  if (purchaseUnitCost.isNegative()) {
    throw new InvalidProductError("Unit cost cannot be negative.");
  }

  const oldQty = new Decimal(state.quantityOnHand);
  const oldAvgCost = new Decimal(state.averageUnitCost);

  const oldValue = oldQty.times(oldAvgCost);
  const purchaseValue = purchaseQty.times(purchaseUnitCost);
  const newQty = oldQty.plus(purchaseQty);
  // oldQty is never negative by construction (sales/decreases are rejected
  // before they'd go below zero), so newQty > 0 whenever purchaseQty > 0 —
  // division by zero can't happen here.
  const newAvgCost = oldValue.plus(purchaseValue).dividedBy(newQty);

  return {
    quantityOnHand: newQty.toFixed(4),
    averageUnitCost: newAvgCost.toFixed(4),
    totalValue: purchaseValue.toFixed(4),
  };
}

/**
 * Applies a sale: on-hand quantity decreases by `quantity`, valued at the
 * CURRENT weighted-average cost (a sale never changes the average itself —
 * only purchases and increasing adjustments do). Refuses, via
 * `InsufficientStockError`, to take quantity negative — this slice has no
 * backorder support (see docs/roadmap.md), so an oversell is always
 * rejected outright rather than queued or silently allowed.
 */
export function applySale(state: StockState, quantity: string, sku: string): SaleResult {
  const saleQty = parsePositiveQuantity(quantity, "Quantity");
  const oldQty = new Decimal(state.quantityOnHand);
  const avgCost = new Decimal(state.averageUnitCost);

  const newQty = oldQty.minus(saleQty);
  if (newQty.isNegative()) {
    throw new InsufficientStockError(sku, oldQty.toFixed(4), saleQty.toFixed(4));
  }

  const cogsAmount = saleQty.times(avgCost);

  return {
    quantityOnHand: newQty.toFixed(4),
    averageUnitCost: avgCost.toFixed(4),
    cogsAmount: cogsAmount.toFixed(4),
    totalValue: cogsAmount.negated().toFixed(4),
  };
}

/**
 * Applies a manual adjustment (`InventoryAdjustmentService`). A positive
 * `quantityDelta` behaves like a purchase at `unitCostOverride` (required —
 * the person recording the adjustment states what the added stock is worth,
 * e.g. the cost of stock found during a stocktake). A negative
 * `quantityDelta` behaves like a sale, valued at the current weighted
 * average, and is refused the same way `applySale` refuses an oversell if
 * it would take quantity negative.
 */
export function applyAdjustment(
  state: StockState,
  quantityDelta: string,
  sku: string,
  unitCostOverride?: string,
): AdjustmentResult {
  const delta = parseDecimal(quantityDelta, "Quantity delta");
  if (delta.isZero()) {
    throw new InvalidProductError("Adjustment quantity delta must not be zero.");
  }

  if (delta.isPositive()) {
    if (unitCostOverride === undefined) {
      throw new InvalidProductError("An increasing adjustment requires a unit cost.");
    }
    const purchase = applyPurchase(state, delta.toFixed(4), unitCostOverride);
    return {
      quantityOnHand: purchase.quantityOnHand,
      averageUnitCost: purchase.averageUnitCost,
      totalValue: purchase.totalValue,
      unitCostUsed: new Decimal(unitCostOverride).toFixed(4),
    };
  }

  const sale = applySale(state, delta.negated().toFixed(4), sku);
  return {
    quantityOnHand: sale.quantityOnHand,
    averageUnitCost: sale.averageUnitCost,
    totalValue: sale.totalValue,
    unitCostUsed: sale.averageUnitCost,
  };
}
