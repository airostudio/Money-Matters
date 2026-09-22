import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import { InvalidInvoiceLineError } from "./errors";
import type { InvoiceLineInput } from "./types";

export interface CalculatedInvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string | null;
  /** quantity × unitPrice, exact Decimal string. */
  lineAmount: string;
  /** lineAmount × the tax code's rate, "0.0000" when there's no tax code. */
  taxAmount: string;
}

export interface CalculatedInvoiceTotals {
  lines: CalculatedInvoiceLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
}

/**
 * Pure, DB-free line/tax/total math — see docs/accounting-engine.md §4:
 * every amount is a `Money`/`decimal.js` value from the moment it's parsed,
 * never a floating-point intermediate. `taxRateByCode` supplies each line's
 * tax rate (a decimal string like "0.1000" for 10%) so this function has no
 * database dependency and is exercised directly by unit/property tests.
 */
export function calculateInvoiceTotals(
  lines: InvoiceLineInput[],
  currency: string,
  taxRateByCode: Map<string, string>,
): CalculatedInvoiceTotals {
  if (lines.length === 0) {
    throw new InvalidInvoiceLineError("An invoice needs at least one line.");
  }

  const calculated = lines.map((line, index) => {
    const quantity = safeDecimal(line.quantity, `Line ${index + 1}: quantity`);
    const unitPrice = Money.of(safeDecimal(line.unitPrice, `Line ${index + 1}: unit price`), currency);

    if (quantity.isZero() || quantity.isNegative()) {
      throw new InvalidInvoiceLineError(`Line ${index + 1}: quantity must be greater than zero.`);
    }
    if (unitPrice.isNegative()) {
      throw new InvalidInvoiceLineError(`Line ${index + 1}: unit price cannot be negative.`);
    }
    if (!line.accountId) {
      throw new InvalidInvoiceLineError(`Line ${index + 1}: an account is required.`);
    }
    if (!line.description.trim()) {
      throw new InvalidInvoiceLineError(`Line ${index + 1}: a description is required.`);
    }

    const lineAmount = unitPrice.multiply(quantity);

    let taxAmount = Money.zero(currency);
    if (line.taxCodeId) {
      const rate = taxRateByCode.get(line.taxCodeId);
      if (rate === undefined) {
        throw new InvalidInvoiceLineError(`Line ${index + 1}: unknown or inactive tax code.`);
      }
      taxAmount = lineAmount.multiply(rate);
    }

    return {
      description: line.description.trim(),
      quantity: quantity.toFixed(4),
      unitPrice: unitPrice.toString(),
      accountId: line.accountId,
      taxCodeId: line.taxCodeId ?? null,
      lineAmount: lineAmount.toString(),
      taxAmount: taxAmount.toString(),
    };
  });

  const subtotal = calculated.reduce(
    (sum, l) => sum.add(Money.of(l.lineAmount, currency)),
    Money.zero(currency),
  );
  const taxTotal = calculated.reduce(
    (sum, l) => sum.add(Money.of(l.taxAmount, currency)),
    Money.zero(currency),
  );

  return {
    lines: calculated,
    subtotal: subtotal.toString(),
    taxTotal: taxTotal.toString(),
    total: subtotal.add(taxTotal).toString(),
  };
}

function safeDecimal(value: string, label: string): Decimal {
  if (value === undefined || value === null || value.trim() === "") {
    throw new InvalidInvoiceLineError(`${label} is required.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new InvalidInvoiceLineError(`${label} must be a plain decimal number.`);
  }
  return new Decimal(value.trim());
}
