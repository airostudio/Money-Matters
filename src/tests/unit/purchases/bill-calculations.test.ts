import { describe, expect, it } from "vitest";
import { calculateBillTotals } from "@/domain/purchases/bill-calculations";
import { InvalidBillLineError } from "@/domain/purchases/errors";

const ACCOUNT_A = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_B = "22222222-2222-2222-2222-222222222222";
const TAX_CODE = "33333333-3333-3333-3333-333333333333";

describe("calculateBillTotals", () => {
  it("computes a single line with no tax", () => {
    const result = calculateBillTotals(
      [{ description: "Stationery", quantity: "2", unitPrice: "150.00", accountId: ACCOUNT_A }],
      "AUD",
      new Map(),
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.lineAmount).toBe("300.0000");
    expect(result.lines[0]!.taxAmount).toBe("0.0000");
    expect(result.subtotal).toBe("300.0000");
    expect(result.taxTotal).toBe("0.0000");
    expect(result.total).toBe("300.0000");
  });

  it("applies a tax code's rate to a line", () => {
    const result = calculateBillTotals(
      [{ description: "Timber", quantity: "10", unitPrice: "20.00", accountId: ACCOUNT_A, taxCodeId: TAX_CODE }],
      "AUD",
      new Map([[TAX_CODE, "0.1000"]]),
    );
    expect(result.subtotal).toBe("200.0000");
    expect(result.taxTotal).toBe("20.0000");
    expect(result.total).toBe("220.0000");
  });

  it("sums multiple lines across different accounts and tax treatment", () => {
    const result = calculateBillTotals(
      [
        { description: "Taxable", quantity: "1", unitPrice: "100.00", accountId: ACCOUNT_A, taxCodeId: TAX_CODE },
        { description: "Exempt", quantity: "3", unitPrice: "50.00", accountId: ACCOUNT_B },
      ],
      "AUD",
      new Map([[TAX_CODE, "0.1000"]]),
    );
    // 100 + 150 = 250 subtotal, 10 tax (only on the first line), 260 total.
    expect(result.subtotal).toBe("250.0000");
    expect(result.taxTotal).toBe("10.0000");
    expect(result.total).toBe("260.0000");
  });

  it("rounds tax to 4 decimal places using banker's rounding, never a float", () => {
    const result = calculateBillTotals(
      [{ description: "Odd amount", quantity: "1", unitPrice: "33.33", accountId: ACCOUNT_A, taxCodeId: TAX_CODE }],
      "AUD",
      new Map([[TAX_CODE, "0.1000"]]),
    );
    expect(result.lines[0]!.taxAmount).toBe("3.3330");
  });

  it("rejects a bill with no lines", () => {
    expect(() => calculateBillTotals([], "AUD", new Map())).toThrow(InvalidBillLineError);
  });

  it("rejects a zero or negative quantity", () => {
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "0", unitPrice: "10.00", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "-1", unitPrice: "10.00", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
  });

  it("rejects a negative unit price", () => {
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "1", unitPrice: "-5.00", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
  });

  it("rejects a missing account", () => {
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "1", unitPrice: "5.00", accountId: "" }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
  });

  it("rejects a blank description", () => {
    expect(() =>
      calculateBillTotals([{ description: "   ", quantity: "1", unitPrice: "5.00", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
  });

  it("rejects a line referencing an unknown tax code", () => {
    expect(() =>
      calculateBillTotals(
        [{ description: "x", quantity: "1", unitPrice: "5.00", accountId: ACCOUNT_A, taxCodeId: "nope" }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidBillLineError);
  });

  it("rejects a non-numeric quantity or unit price", () => {
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "abc", unitPrice: "5.00", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
    expect(() =>
      calculateBillTotals([{ description: "x", quantity: "1", unitPrice: "abc", accountId: ACCOUNT_A }], "AUD", new Map()),
    ).toThrow(InvalidBillLineError);
  });
});
