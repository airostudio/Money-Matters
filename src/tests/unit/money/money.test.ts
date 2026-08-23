import { describe, expect, it } from "vitest";
import { Money, MoneyCurrencyMismatchError } from "@/domain/money/money";

describe("Money", () => {
  it("adds and subtracts within the same currency", () => {
    const a = Money.of("100.50", "AUD");
    const b = Money.of("49.25", "AUD");
    expect(a.add(b).toString()).toBe("149.7500");
    expect(a.subtract(b).toString()).toBe("51.2500");
  });

  it("rejects arithmetic across different currencies", () => {
    const a = Money.of("100", "AUD");
    const b = Money.of("100", "USD");
    expect(() => a.add(b)).toThrow(MoneyCurrencyMismatchError);
  });

  it("never loses precision the way a float would", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754 float; Money must get this exactly right.
    const a = Money.of("0.10", "AUD");
    const b = Money.of("0.20", "AUD");
    expect(a.add(b).toString()).toBe("0.3000");
  });

  it("formats with a fixed 4 decimal places, matching the Decimal(19,4) columns", () => {
    expect(Money.of("5", "AUD").toString()).toBe("5.0000");
    expect(Money.zero("AUD").toString()).toBe("0.0000");
  });

  it("compares and detects sign correctly", () => {
    expect(Money.of("10", "AUD").isPositive()).toBe(true);
    expect(Money.of("-10", "AUD").isNegative()).toBe(true);
    expect(Money.of("0", "AUD").isZero()).toBe(true);
    expect(Money.of("10", "AUD").compareTo(Money.of("5", "AUD"))).toBe(1);
  });

  it("converts to another currency by a rate", () => {
    const aud = Money.of("100", "AUD");
    const usd = aud.convert("0.65", "USD");
    expect(usd.currency).toBe("USD");
    expect(usd.toString()).toBe("65.0000");
  });

  describe("allocate", () => {
    it("splits evenly when it divides cleanly", () => {
      const shares = Money.of("100", "AUD").allocate([1, 1]);
      expect(shares.map((s) => s.toString())).toEqual(["50.0000", "50.0000"]);
    });

    it("distributes the remainder without losing or duplicating any cents", () => {
      // 100 / 3 = 33.3333... — the three shares must sum back to exactly 100.
      const shares = Money.of("100", "AUD").allocate([1, 1, 1]);
      const total = shares.reduce((sum, s) => sum.add(s), Money.zero("AUD"));
      expect(total.toString()).toBe("100.0000");
      // largest-remainder method: one share gets the extra fractional unit.
      const asStrings = shares.map((s) => s.toString()).sort();
      expect(asStrings).toEqual(["33.3333", "33.3333", "33.3334"]);
    });

    it("weights shares proportionally and still sums exactly", () => {
      const shares = Money.of("999.99", "AUD").allocate([50, 30, 20]);
      const total = shares.reduce((sum, s) => sum.add(s), Money.zero("AUD"));
      expect(total.toString()).toBe("999.9900");
    });

    it("rejects a non-positive total weight", () => {
      expect(() => Money.of("10", "AUD").allocate([0, 0])).toThrow();
    });
  });
});
