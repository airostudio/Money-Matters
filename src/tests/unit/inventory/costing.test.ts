import { describe, expect, it } from "vitest";
import { applyAdjustment, applyPurchase, applySale, assertWeightedAverage } from "@/domain/inventory/costing";
import { InsufficientStockError, InvalidProductError } from "@/domain/inventory/errors";

describe("inventory costing (weighted average)", () => {
  it("values the first purchase at its own unit cost", () => {
    const result = applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "10", "5.00");
    expect(result.quantityOnHand).toBe("10.0000");
    expect(result.averageUnitCost).toBe("5.0000");
    expect(result.totalValue).toBe("50.0000");
  });

  it("recomputes the weighted average across two purchases at different costs", () => {
    const first = applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "10", "5.00");
    // 10 @ 5.00 = 50; + 10 @ 7.00 = 70; total 120 / 20 = 6.00
    const second = applyPurchase(first, "10", "7.00");
    expect(second.quantityOnHand).toBe("20.0000");
    expect(second.averageUnitCost).toBe("6.0000");
  });

  it("handles an uneven weighted average correctly", () => {
    // 3 @ 10.00 = 30; + 7 @ 20.00 = 140; total 170 / 10 = 17.00
    const first = applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "3", "10.00");
    const second = applyPurchase(first, "7", "20.00");
    expect(second.averageUnitCost).toBe("17.0000");
  });

  it("a sale never changes the weighted-average cost, only the quantity", () => {
    const afterPurchase = applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "10", "5.00");
    const afterSale = applySale(afterPurchase, "4", "SKU-1");
    expect(afterSale.quantityOnHand).toBe("6.0000");
    expect(afterSale.averageUnitCost).toBe("5.0000");
    expect(afterSale.cogsAmount).toBe("20.0000"); // 4 @ 5.00
  });

  it("rejects a sale that would take quantity negative", () => {
    const state = { quantityOnHand: "5", averageUnitCost: "5.00" };
    expect(() => applySale(state, "6", "SKU-1")).toThrow(InsufficientStockError);
  });

  it("allows a sale that exactly exhausts on-hand quantity", () => {
    const state = { quantityOnHand: "5", averageUnitCost: "5.00" };
    const result = applySale(state, "5", "SKU-1");
    expect(result.quantityOnHand).toBe("0.0000");
  });

  it("an increasing adjustment behaves like a purchase at the stated cost", () => {
    const state = { quantityOnHand: "10", averageUnitCost: "5.00" };
    const result = applyAdjustment(state, "5", "SKU-1", "8.00");
    // 10 @ 5 = 50; + 5 @ 8 = 40; total 90 / 15 = 6.00
    expect(result.quantityOnHand).toBe("15.0000");
    expect(result.averageUnitCost).toBe("6.0000");
    expect(result.totalValue).toBe("40.0000");
  });

  it("a decreasing adjustment behaves like a sale at the current average, and requires no cost", () => {
    const state = { quantityOnHand: "10", averageUnitCost: "5.00" };
    const result = applyAdjustment(state, "-3", "SKU-1");
    expect(result.quantityOnHand).toBe("7.0000");
    expect(result.averageUnitCost).toBe("5.0000");
    expect(result.totalValue).toBe("-15.0000");
  });

  it("rejects a decreasing adjustment that would take quantity negative", () => {
    const state = { quantityOnHand: "2", averageUnitCost: "5.00" };
    expect(() => applyAdjustment(state, "-3", "SKU-1")).toThrow(InsufficientStockError);
  });

  it("rejects an increasing adjustment with no unit cost", () => {
    const state = { quantityOnHand: "2", averageUnitCost: "5.00" };
    expect(() => applyAdjustment(state, "3", "SKU-1")).toThrow(InvalidProductError);
  });

  it("rejects a zero adjustment", () => {
    const state = { quantityOnHand: "2", averageUnitCost: "5.00" };
    expect(() => applyAdjustment(state, "0", "SKU-1", "5.00")).toThrow(InvalidProductError);
  });

  it("rejects a negative or zero purchase quantity", () => {
    expect(() => applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "0", "5.00")).toThrow(InvalidProductError);
    expect(() => applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "-1", "5.00")).toThrow(InvalidProductError);
  });

  it("rejects a negative unit cost on purchase", () => {
    expect(() => applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "1", "-5.00")).toThrow(InvalidProductError);
  });

  it("assertWeightedAverage accepts WEIGHTED_AVERAGE and rejects anything else", () => {
    expect(() => assertWeightedAverage("WEIGHTED_AVERAGE")).not.toThrow();
    expect(() => assertWeightedAverage("FIFO")).toThrow(InvalidProductError);
  });

  it("supports fractional quantities exactly (no float drift)", () => {
    const first = applyPurchase({ quantityOnHand: "0", averageUnitCost: "0" }, "0.1", "10.00");
    const second = applyPurchase(first, "0.2", "10.00");
    // 0.1 + 0.2 must be exactly 0.3, never 0.30000000000000004
    expect(second.quantityOnHand).toBe("0.3000");
  });
});
