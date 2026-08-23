import { describe, expect, it } from "vitest";
import { parseAmount, parseCsvStatement, parseStatementDate } from "@/domain/banking/parsers/csv";
import { StatementParseError } from "@/domain/banking/errors";

describe("parseAmount", () => {
  it("parses a plain decimal", () => {
    expect(parseAmount("45.00")?.toFixed(2)).toBe("45.00");
  });

  it("parses a negative amount", () => {
    expect(parseAmount("-45.00")?.toFixed(2)).toBe("-45.00");
  });

  it("treats parentheses as negative", () => {
    expect(parseAmount("(45.00)")?.toFixed(2)).toBe("-45.00");
  });

  it("strips a currency symbol and thousands separators", () => {
    expect(parseAmount("$1,234.56")?.toFixed(2)).toBe("1234.56");
  });

  it("returns null for unparsable input", () => {
    expect(parseAmount("n/a")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("parseStatementDate", () => {
  it("parses an ISO date", () => {
    const date = parseStatementDate("2026-01-15");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("parses DD/MM/YYYY under the AU default", () => {
    const date = parseStatementDate("05/01/2026", "DMY");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("parses MM/DD/YYYY when explicitly requested", () => {
    const date = parseStatementDate("05/01/2026", "MDY");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  it("resolves an unambiguous date regardless of the configured order", () => {
    // Day 25 can't be a month, so this is unambiguously 25 Dec 2026 even under MDY.
    const date = parseStatementDate("25/12/2026", "MDY");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-12-25");
  });

  it("returns null for garbage", () => {
    expect(parseStatementDate("not a date")).toBeNull();
  });
});

describe("parseCsvStatement", () => {
  it("auto-detects Date/Description/Amount columns", () => {
    const csv = ["Date,Description,Amount", "15/01/2026,Coffee,-4.50", "16/01/2026,Salary,2500.00"].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ description: "Coffee", amount: "-4.5000" });
    expect(result.rows[1]).toMatchObject({ description: "Salary", amount: "2500.0000" });
  });

  it("auto-detects a separate Debit/Credit column pair", () => {
    const csv = ["Date,Details,Debit,Credit", "01/02/2026,Rent,1200.00,", "02/02/2026,Refund,,50.00"].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.rows[0]).toMatchObject({ amount: "-1200.0000" });
    expect(result.rows[1]).toMatchObject({ amount: "50.0000" });
  });

  it("handles quoted fields containing commas", () => {
    const csv = ['Date,Description,Amount', '15/01/2026,"Smith, John — invoice",100.00'].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.rows[0]?.description).toBe("Smith, John — invoice");
  });

  it("handles escaped quotes inside a quoted field", () => {
    const csv = ['Date,Description,Amount', '15/01/2026,"Contains ""quotes"" here",10.00'].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.rows[0]?.description).toBe('Contains "quotes" here');
  });

  it("uses an explicit column mapping when provided", () => {
    const csv = ["TxnDate;Narrative;Value", "15/01/2026;Coffee;-4.50"].join("\n").replace(/;/g, ",");
    const result = parseCsvStatement(csv, {
      mapping: { date: "TxnDate", description: "Narrative", amount: "Value" },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.amount).toBe("-4.5000");
  });

  it("skips an unparsable row and reports why, instead of failing the whole import", () => {
    const csv = ["Date,Description,Amount", "not-a-date,Coffee,-4.50", "16/01/2026,Salary,2500.00"].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Row 2/);
  });

  it("throws a StatementParseError when no date column can be found", () => {
    const csv = ["Foo,Bar", "1,2"].join("\n");
    expect(() => parseCsvStatement(csv)).toThrow(StatementParseError);
  });

  it("throws a StatementParseError on an empty file", () => {
    expect(() => parseCsvStatement("")).toThrow(StatementParseError);
  });

  it("keeps the original row for audit/display in raw", () => {
    const csv = ["Date,Description,Amount,Balance", "15/01/2026,Coffee,-4.50,995.50"].join("\n");
    const result = parseCsvStatement(csv);
    expect(result.rows[0]?.raw).toMatchObject({ Date: "15/01/2026", Description: "Coffee" });
    expect(result.rows[0]?.balanceAfter).toBe("995.5000");
  });
});
