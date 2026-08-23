import Decimal from "decimal.js";

// Ledger precision: 4 decimal places, matching the Decimal(19,4) columns in
// src/db/schema.ts. See docs/decisions/0003-monetary-precision.md.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

const LEDGER_DECIMAL_PLACES = 4;

export class MoneyCurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine amounts in different currencies: ${a} vs ${b}`);
    this.name = "MoneyCurrencyMismatchError";
  }
}

/**
 * A monetary amount tied to a currency. Wraps decimal.js so that no domain
 * code ever performs float arithmetic on money — see
 * docs/accounting-engine.md §4 ("Money, never floats").
 *
 * Construct from a decimal *string* (or another exact source), never from a
 * float literal that could already have lost precision before reaching
 * this constructor.
 */
export class Money {
  private readonly amount: Decimal;
  readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency);
  }

  static of(amount: string | number | Decimal, currency: string): Money {
    return new Money(new Decimal(amount), currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  multiply(factor: string | number | Decimal): Money {
    return new Money(this.amount.times(factor), this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  /** Converts to another currency by a known rate — used for the base-currency amount on a journal line. */
  convert(rate: string | number | Decimal, toCurrency: string): Money {
    return new Money(this.amount.times(rate), toCurrency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  isNegative(): boolean {
    return this.amount.lessThan(0);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  compareTo(other: Money): number {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount);
  }

  /**
   * Splits this amount into `parts` shares proportional to `weights`, using
   * a largest-remainder allocation so the shares always sum back to exactly
   * this amount — no lost or duplicated cents. See
   * docs/decisions/0003-monetary-precision.md.
   */
  allocate(weights: number[]): Money[] {
    if (weights.length === 0) {
      throw new Error("allocate() requires at least one weight.");
    }
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      throw new Error("allocate() requires a positive total weight.");
    }

    const scale = new Decimal(10).pow(LEDGER_DECIMAL_PLACES);
    const totalUnits = this.amount.times(scale).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);

    const rawShares = weights.map((w) => totalUnits.times(w).dividedBy(totalWeight));
    const flooredShares = rawShares.map((s) => s.toDecimalPlaces(0, Decimal.ROUND_DOWN));
    let remainder = totalUnits.minus(
      flooredShares.reduce((sum, s) => sum.plus(s), new Decimal(0)),
    );

    const remainders = rawShares.map((s, i) => ({
      index: i,
      fraction: s.minus(flooredShares[i]!),
    }));
    remainders.sort((a, b) => b.fraction.comparedTo(a.fraction));

    const units = [...flooredShares];
    for (const { index } of remainders) {
      if (remainder.lessThanOrEqualTo(0)) break;
      units[index] = units[index]!.plus(1);
      remainder = remainder.minus(1);
    }

    return units.map((u) => new Money(u.dividedBy(scale), this.currency));
  }

  /** Exact decimal string, e.g. "1234.5000" — the only safe serialization for money. */
  toString(): string {
    return this.amount.toFixed(LEDGER_DECIMAL_PLACES);
  }

  toDecimal(): Decimal {
    return this.amount;
  }
}
