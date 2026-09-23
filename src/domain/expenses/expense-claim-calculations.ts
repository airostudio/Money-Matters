import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import { InvalidExpenseClaimLineError } from "./errors";
import type { ExpenseClaimLineInput } from "./types";

export interface CalculatedExpenseClaimLine {
  description: string;
  amount: string;
  expenseAccountId: string;
  taxCodeId: string | null;
  /** amount × the tax code's rate, "0.0000" when there's no tax code. */
  taxAmount: string;
  category: string | null;
  receiptId: string | null;
}

export interface CalculatedExpenseClaimTotals {
  lines: CalculatedExpenseClaimLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
}

/**
 * Pure, DB-free line/tax/total math for expense claims — the same shape as
 * `src/domain/purchases/bill-calculations.ts`, minus quantity × unit price
 * (an expense line is a single amount, not a quantity of something). Every
 * amount is a `Money`/`decimal.js` value from the moment it's parsed, never
 * a floating-point intermediate — docs/accounting-engine.md §4.
 */
export function calculateExpenseClaimTotals(
  lines: ExpenseClaimLineInput[],
  currency: string,
  taxRateByCode: Map<string, string>,
): CalculatedExpenseClaimTotals {
  if (lines.length === 0) {
    throw new InvalidExpenseClaimLineError("An expense claim needs at least one line.");
  }

  const calculated = lines.map((line, index) => {
    const amount = Money.of(safeDecimal(line.amount, `Line ${index + 1}: amount`), currency);

    if (amount.isZero() || amount.isNegative()) {
      throw new InvalidExpenseClaimLineError(`Line ${index + 1}: amount must be greater than zero.`);
    }
    if (!line.expenseAccountId) {
      throw new InvalidExpenseClaimLineError(`Line ${index + 1}: an expense account is required.`);
    }
    if (!line.description.trim()) {
      throw new InvalidExpenseClaimLineError(`Line ${index + 1}: a description is required.`);
    }

    let taxAmount = Money.zero(currency);
    if (line.taxCodeId) {
      const rate = taxRateByCode.get(line.taxCodeId);
      if (rate === undefined) {
        throw new InvalidExpenseClaimLineError(`Line ${index + 1}: unknown or inactive tax code.`);
      }
      taxAmount = amount.multiply(rate);
    }

    return {
      description: line.description.trim(),
      amount: amount.toString(),
      expenseAccountId: line.expenseAccountId,
      taxCodeId: line.taxCodeId ?? null,
      taxAmount: taxAmount.toString(),
      category: line.category?.trim() || null,
      receiptId: line.receiptId ?? null,
    };
  });

  const subtotal = calculated.reduce(
    (sum, l) => sum.add(Money.of(l.amount, currency)),
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
    throw new InvalidExpenseClaimLineError(`${label} is required.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new InvalidExpenseClaimLineError(`${label} must be a plain decimal number.`);
  }
  return new Decimal(value.trim());
}
