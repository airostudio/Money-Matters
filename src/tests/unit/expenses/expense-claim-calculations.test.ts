import { describe, expect, it } from "vitest";
import { calculateExpenseClaimTotals } from "@/domain/expenses/expense-claim-calculations";
import { InvalidExpenseClaimLineError } from "@/domain/expenses/errors";

const ACCOUNT_A = "11111111-1111-1111-1111-111111111111";
const TAX_CODE_10 = "tax-10";

describe("calculateExpenseClaimTotals", () => {
  it("computes subtotal/tax/total for a single untaxed line", () => {
    const result = calculateExpenseClaimTotals(
      [{ description: "Taxi", amount: "45.00", expenseAccountId: ACCOUNT_A }],
      "AUD",
      new Map(),
    );
    expect(result.subtotal).toBe("45.0000");
    expect(result.taxTotal).toBe("0.0000");
    expect(result.total).toBe("45.0000");
    expect(result.lines[0]!.taxAmount).toBe("0.0000");
  });

  it("computes GST-exact tax for a taxed line", () => {
    const result = calculateExpenseClaimTotals(
      [{ description: "Hotel", amount: "200.00", expenseAccountId: ACCOUNT_A, taxCodeId: TAX_CODE_10 }],
      "AUD",
      new Map([[TAX_CODE_10, "0.1000"]]),
    );
    expect(result.subtotal).toBe("200.0000");
    expect(result.taxTotal).toBe("20.0000");
    expect(result.total).toBe("220.0000");
  });

  it("sums multiple lines exactly, never accumulating float error", () => {
    const result = calculateExpenseClaimTotals(
      [
        { description: "a", amount: "10.10", expenseAccountId: ACCOUNT_A },
        { description: "b", amount: "10.20", expenseAccountId: ACCOUNT_A },
        { description: "c", amount: "10.30", expenseAccountId: ACCOUNT_A },
      ],
      "AUD",
      new Map(),
    );
    expect(result.subtotal).toBe("30.6000");
  });

  it("carries category and receiptId through untouched", () => {
    const result = calculateExpenseClaimTotals(
      [{ description: "Lunch", amount: "25.00", expenseAccountId: ACCOUNT_A, category: "Meals", receiptId: "r1" }],
      "AUD",
      new Map(),
    );
    expect(result.lines[0]!.category).toBe("Meals");
    expect(result.lines[0]!.receiptId).toBe("r1");
  });

  it("rejects an empty line list", () => {
    expect(() => calculateExpenseClaimTotals([], "AUD", new Map())).toThrow(InvalidExpenseClaimLineError);
  });

  it("rejects a zero amount", () => {
    expect(() =>
      calculateExpenseClaimTotals([{ description: "x", amount: "0.00", expenseAccountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(/greater than zero/);
  });

  it("rejects a negative amount", () => {
    expect(() =>
      calculateExpenseClaimTotals([{ description: "x", amount: "-5.00", expenseAccountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(/greater than zero/);
  });

  it("rejects a missing account", () => {
    expect(() =>
      calculateExpenseClaimTotals([{ description: "x", amount: "5.00", expenseAccountId: "" }], "AUD", new Map()),
    ).toThrow(/account is required/);
  });

  it("rejects a blank description", () => {
    expect(() =>
      calculateExpenseClaimTotals([{ description: "  ", amount: "5.00", expenseAccountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(/description is required/);
  });

  it("rejects an unknown tax code", () => {
    expect(() =>
      calculateExpenseClaimTotals(
        [{ description: "x", amount: "5.00", expenseAccountId: ACCOUNT_A, taxCodeId: "unknown" }],
        "AUD",
        new Map(),
      ),
    ).toThrow(/unknown or inactive tax code/);
  });

  it("rejects a non-decimal amount", () => {
    expect(() =>
      calculateExpenseClaimTotals([{ description: "x", amount: "not-a-number", expenseAccountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(/plain decimal number/);
  });
});
