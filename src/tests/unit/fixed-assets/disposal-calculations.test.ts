import { describe, expect, it } from "vitest";
import { calculateDisposalGainLoss, calculateWriteOffLoss } from "@/domain/fixed-assets/disposal-calculations";

describe("disposal gain/loss calculation", () => {
  it("recognizes a gain when proceeds exceed net book value", () => {
    const result = calculateDisposalGainLoss("12000.00", "9000.00", "4000.00");
    // netBookValue = 12000 - 9000 = 3000; gain = 4000 - 3000 = 1000.
    expect(result.netBookValue).toBe("3000.0000");
    expect(result.gainLoss).toBe("1000.0000");
  });

  it("recognizes a loss when proceeds are below net book value", () => {
    const result = calculateDisposalGainLoss("12000.00", "6000.00", "4000.00");
    // netBookValue = 12000 - 6000 = 6000; loss = 4000 - 6000 = -2000.
    expect(result.netBookValue).toBe("6000.0000");
    expect(result.gainLoss).toBe("-2000.0000");
  });

  it("recognizes neither a gain nor a loss when proceeds exactly equal net book value", () => {
    const result = calculateDisposalGainLoss("12000.00", "8000.00", "4000.00");
    expect(result.gainLoss).toBe("0.0000");
  });

  it("handles a full write-off's zero proceeds as a full loss", () => {
    const result = calculateDisposalGainLoss("12000.00", "5000.00", "0");
    expect(result.gainLoss).toBe("-7000.0000");
  });
});

describe("write-off loss calculation", () => {
  it("is always exactly the remaining net book value", () => {
    const result = calculateWriteOffLoss("12000.00", "9500.00");
    expect(result.netBookValue).toBe("2500.0000");
    expect(result.loss).toBe("2500.0000");
  });

  it("is zero for an already-fully-depreciated asset", () => {
    const result = calculateWriteOffLoss("12000.00", "12000.00");
    expect(result.loss).toBe("0.0000");
  });
});
