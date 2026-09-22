import { describe, expect, it } from "vitest";
import { calculateInvoiceTotals } from "@/domain/sales/invoice-calculations";
import { InvalidInvoiceLineError } from "@/domain/sales/errors";

const ACCOUNT_A = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_B = "22222222-2222-2222-2222-222222222222";
const TAX_CODE = "33333333-3333-3333-3333-333333333333";

describe("calculateInvoiceTotals", () => {
  it("computes a single line with no tax", () => {
    const result = calculateInvoiceTotals(
      [{ description: "Consulting", quantity: "2", unitPrice: "150.00", accountId: ACCOUNT_A }],
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
    const result = calculateInvoiceTotals(
      [{ description: "Widgets", quantity: "10", unitPrice: "20.00", accountId: ACCOUNT_A, taxCodeId: TAX_CODE }],
      "AUD",
      new Map([[TAX_CODE, "0.1000"]]),
    );
    expect(result.subtotal).toBe("200.0000");
    expect(result.taxTotal).toBe("20.0000");
    expect(result.total).toBe("220.0000");
  });

  it("sums multiple lines across different accounts and tax treatment", () => {
    const result = calculateInvoiceTotals(
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
    // 33.33 * 0.1 = 3.333 exactly — no rounding surprise, but proves the
    // arithmetic goes through Decimal rather than IEEE-754 float (0.1 * 33.33
    // in JS float math is 3.3330000000000006).
    const result = calculateInvoiceTotals(
      [{ description: "Odd amount", quantity: "1", unitPrice: "33.33", accountId: ACCOUNT_A, taxCodeId: TAX_CODE }],
      "AUD",
      new Map([[TAX_CODE, "0.1000"]]),
    );
    expect(result.lines[0]!.taxAmount).toBe("3.3330");
  });

  it("rejects an invoice with no lines", () => {
    expect(() => calculateInvoiceTotals([], "AUD", new Map())).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a zero or negative quantity", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "0", unitPrice: "10.00", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "-1", unitPrice: "10.00", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a negative unit price", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "1", unitPrice: "-5.00", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a missing account", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "1", unitPrice: "5.00", accountId: "" }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a blank description", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "   ", quantity: "1", unitPrice: "5.00", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a line referencing an unknown tax code", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "1", unitPrice: "5.00", accountId: ACCOUNT_A, taxCodeId: "nope" }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });

  it("rejects a non-numeric quantity or unit price", () => {
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "abc", unitPrice: "5.00", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
    expect(() =>
      calculateInvoiceTotals(
        [{ description: "x", quantity: "1", unitPrice: "abc", accountId: ACCOUNT_A }],
        "AUD",
        new Map(),
      ),
    ).toThrow(InvalidInvoiceLineError);
  });
});
