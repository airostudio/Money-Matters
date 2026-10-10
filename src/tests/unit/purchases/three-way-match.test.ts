import { describe, expect, it } from "vitest";
import { threeWayMatch } from "@/domain/purchases/three-way-match";

const poLine = (overrides: Partial<{ id: string; description: string; quantity: string; quantityReceived: string; unitPrice: string }> = {}) => ({
  id: "line-1",
  description: "Widgets",
  quantity: "10",
  quantityReceived: "10",
  unitPrice: "50.00",
  ...overrides,
});

describe("threeWayMatch", () => {
  it("matches cleanly when the bill agrees with what was ordered and received", () => {
    const result = threeWayMatch([poLine()], [{ poLineId: "line-1", quantity: "10", unitPrice: "50.00" }], "AUD");
    expect(result.matched).toBe(true);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("flags a quantity mismatch when the bill claims more than was received", () => {
    const result = threeWayMatch(
      [poLine({ quantity: "10", quantityReceived: "10" })],
      [{ poLineId: "line-1", quantity: "12", unitPrice: "50.00" }],
      "AUD",
    );
    expect(result.matched).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.kind).toBe("QUANTITY_EXCEEDS_ORDERED");
    expect(result.discrepancies[0]!.message).toContain("ordered 10, received 10, bill claims 12");
  });

  it("flags QUANTITY_EXCEEDS_RECEIVED (not ORDERED) when the bill exceeds what's received but not what was ordered", () => {
    const result = threeWayMatch(
      [poLine({ quantity: "10", quantityReceived: "6" })],
      [{ poLineId: "line-1", quantity: "8", unitPrice: "50.00" }],
      "AUD",
    );
    expect(result.matched).toBe(false);
    expect(result.discrepancies[0]!.kind).toBe("QUANTITY_EXCEEDS_RECEIVED");
  });

  it("flags a price mismatch", () => {
    const result = threeWayMatch([poLine()], [{ poLineId: "line-1", quantity: "10", unitPrice: "55.00" }], "AUD");
    expect(result.matched).toBe(false);
    expect(result.discrepancies[0]!.kind).toBe("PRICE_MISMATCH");
    expect(result.discrepancies[0]!.message).toContain("price mismatch");
  });

  it("can flag both a quantity and a price mismatch on the same line", () => {
    const result = threeWayMatch(
      [poLine({ quantity: "10", quantityReceived: "10" })],
      [{ poLineId: "line-1", quantity: "12", unitPrice: "55.00" }],
      "AUD",
    );
    expect(result.discrepancies).toHaveLength(2);
    expect(result.discrepancies.map((d) => d.kind).sort()).toEqual(["PRICE_MISMATCH", "QUANTITY_EXCEEDS_ORDERED"]);
  });

  it("matches when billing less than the full received quantity (a partial bill)", () => {
    const result = threeWayMatch([poLine({ quantity: "10", quantityReceived: "10" })], [{ poLineId: "line-1", quantity: "4", unitPrice: "50.00" }], "AUD");
    expect(result.matched).toBe(true);
  });

  it("handles multiple lines independently", () => {
    const result = threeWayMatch(
      [poLine({ id: "a", quantity: "5", quantityReceived: "5" }), poLine({ id: "b", quantity: "3", quantityReceived: "3" })],
      [
        { poLineId: "a", quantity: "5", unitPrice: "50.00" },
        { poLineId: "b", quantity: "5", unitPrice: "50.00" },
      ],
      "AUD",
    );
    expect(result.matched).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.poLineId).toBe("b");
  });
});
