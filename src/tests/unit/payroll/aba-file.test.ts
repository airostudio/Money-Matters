import { describe, expect, it } from "vitest";
import { AbaValidationError, generateAbaFile } from "@/domain/payroll/aba-file";

const header = {
  financialInstitution: "xyz",
  userName: "Test Pty Ltd",
  userId: "123",
  description: "PAYROLL",
  processingDate: new Date("2026-08-14T00:00:00Z"),
};
const trace = { bsb: "062-000", accountNumber: "12345678", remitterName: "Test Pty Ltd" };

describe("ABA (Direct Entry) file generation (layout per Westpac / Cemtex specifications)", () => {
  const result = generateAbaFile(header, trace, [
    { bsb: "032-001", accountNumber: "111222333", amount: "3084.6154", accountTitle: "Alex Salary", lodgementReference: "PAY 2026-08-14" },
    { bsb: "083123", accountNumber: "9876", amount: "1000", accountTitle: "Bo Hourly", lodgementReference: "PAY 2026-08-14" },
  ]);
  const lines = result.content.split("\r\n");

  it("has a 120-character descriptive record at the documented positions", () => {
    const h = lines[0]!;
    expect(h).toHaveLength(120);
    expect(h[0]).toBe("0");
    expect(h.slice(1, 18)).toBe(" ".repeat(17));
    expect(h.slice(18, 20)).toBe("01");
    expect(h.slice(20, 23)).toBe("XYZ");
    expect(h.slice(23, 30)).toBe(" ".repeat(7));
    expect(h.slice(30, 56)).toBe("Test Pty Ltd".padEnd(26));
    expect(h.slice(56, 62)).toBe("000123");
    expect(h.slice(62, 74)).toBe("PAYROLL".padEnd(12));
    expect(h.slice(74, 80)).toBe("140826");
    expect(h.slice(80)).toBe(" ".repeat(40));
  });

  it("has a 120-character detail record per payment, amounts in cents", () => {
    const d = lines[1]!;
    expect(d).toHaveLength(120);
    expect(d[0]).toBe("1");
    expect(d.slice(1, 8)).toBe("032-001");
    expect(d.slice(8, 17)).toBe("111222333");
    expect(d[17]).toBe(" ");
    expect(d.slice(18, 20)).toBe("53");
    expect(d.slice(20, 30)).toBe("0000308462"); // 3084.6154 -> 308,462 cents (half-up)
    expect(d.slice(30, 62)).toBe("Alex Salary".padEnd(32));
    expect(d.slice(62, 80)).toBe("PAY 2026-08-14".padEnd(18));
    expect(d.slice(80, 87)).toBe("062-000");
    expect(d.slice(87, 96)).toBe(" 12345678");
    expect(d.slice(96, 112)).toBe("Test Pty Ltd".padEnd(16));
    expect(d.slice(112)).toBe("00000000");
    const d2 = lines[2]!;
    expect(d2.slice(1, 8)).toBe("083-123");
    expect(d2.slice(8, 17)).toBe("     9876");
    expect(d2.slice(20, 30)).toBe("0000100000");
  });

  it("has a file total record with the count and totals", () => {
    const t = lines[3]!;
    expect(t).toHaveLength(120);
    expect(t.slice(0, 8)).toBe("7999-999");
    expect(t.slice(8, 20)).toBe(" ".repeat(12));
    expect(t.slice(20, 30)).toBe("0000408462"); // 308462 + 100000
    expect(t.slice(30, 40)).toBe("0000408462");
    expect(t.slice(40, 50)).toBe("0000000000");
    expect(t.slice(50, 74)).toBe(" ".repeat(24));
    expect(t.slice(74, 80)).toBe("000002");
    expect(t.slice(80)).toBe(" ".repeat(40));
    expect(result.recordCount).toBe(2);
    expect(result.totalCents).toBe("408462");
  });

  it("reports the sub-cent rounding difference against the exact ledger amounts", () => {
    // exact 4084.6154 vs file 4084.62 -> -0.0046
    expect(result.roundingDifference).toBe("-0.0046");
  });

  it("fails closed on anything it cannot represent", () => {
    const pay = { bsb: "032-001", accountNumber: "111222333", amount: "10", accountTitle: "A", lodgementReference: "R" };
    expect(() => generateAbaFile(header, trace, [])).toThrow(AbaValidationError);
    expect(() => generateAbaFile(header, trace, [{ ...pay, bsb: "12-34" }])).toThrow(/six digits/);
    expect(() => generateAbaFile(header, trace, [{ ...pay, accountNumber: "0000" }])).toThrow(/all zeros/);
    expect(() => generateAbaFile(header, trace, [{ ...pay, accountNumber: "1234567890" }])).toThrow(/nine characters/);
    expect(() => generateAbaFile(header, trace, [{ ...pay, amount: "0.004" }])).toThrow(/greater than zero/);
    expect(() => generateAbaFile(header, trace, [{ ...pay, accountTitle: "x".repeat(33) }])).toThrow(/longer than 32/);
    expect(() => generateAbaFile(header, trace, [{ ...pay, accountTitle: "Badé" }])).toThrow(/not valid/);
    expect(() => generateAbaFile({ ...header, financialInstitution: "WESTPAC" }, trace, [pay])).toThrow(/three letters/);
    expect(() => generateAbaFile({ ...header, userId: "ABC" }, trace, [pay])).toThrow(/six digits/);
  });
});
