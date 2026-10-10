import { describe, expect, it } from "vitest";
import { computeProjectVariance } from "@/domain/projects/profitability-calculations";

describe("computeProjectVariance", () => {
  it("computes estimated and actual summaries with margin", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "100000.00", cost: "60000.00" },
      actual: { revenue: "80000.00", cost: "55000.00" },
    });

    expect(result.estimated.revenue).toBe("100000.0000");
    expect(result.estimated.cost).toBe("60000.0000");
    expect(result.estimated.profit).toBe("40000.0000");
    expect(result.estimated.margin).toBe("0.4000");

    expect(result.actual.revenue).toBe("80000.0000");
    expect(result.actual.cost).toBe("55000.0000");
    expect(result.actual.profit).toBe("25000.0000");
    expect(result.actual.margin).toBe("0.3125");
  });

  it("computes signed variance between actual and estimated", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "100000.00", cost: "60000.00" },
      actual: { revenue: "80000.00", cost: "65000.00" },
    });

    expect(result.variance.revenue).toBe("-20000.0000");
    expect(result.variance.cost).toBe("5000.0000");
    expect(result.variance.profit).toBe("-25000.0000");
  });

  it("returns a null margin when revenue is zero, not a divide-by-zero crash or a fabricated zero", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "0", cost: "0" },
      actual: { revenue: "0", cost: "500.00" },
    });
    expect(result.estimated.margin).toBeNull();
    expect(result.actual.margin).toBeNull();
  });

  it("produces a plain-language explanation for a cost overrun", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "50000.00", cost: "30000.00" },
      actual: { revenue: "50000.00", cost: "33200.00" },
    });
    expect(result.explanations.find((e) => e.startsWith("Cost"))).toBe("Cost exceeded estimate by 3200.0000.");
  });

  it("produces a per-category breakdown explanation, e.g. Labour exceeding its estimate", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "50000.00", cost: "30000.00" },
      actual: { revenue: "50000.00", cost: "33200.00" },
      costBreakdown: [{ label: "Labour", estimated: "20000.00", actual: "23200.00" }],
    });

    const labourLine = result.costBreakdown.find((l) => l.label === "Labour");
    expect(labourLine).toBeDefined();
    expect(labourLine!.variance).toBe("3200.0000");
    expect(labourLine!.explanation).toBe("Labour exceeded estimate by 3200.0000.");
    expect(result.explanations).toContain(labourLine!.explanation);
  });

  it("says a line is exactly on budget when estimated equals actual", () => {
    const result = computeProjectVariance({
      currency: "AUD",
      estimated: { revenue: "10000.00", cost: "5000.00" },
      actual: { revenue: "10000.00", cost: "5000.00" },
    });
    expect(result.explanations.find((e) => e.startsWith("Cost"))).toBe("Cost is exactly on budget.");
  });
});
