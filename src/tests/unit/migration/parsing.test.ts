import { describe, expect, it } from "vitest";
import { CsvError, MAX_ROWS, parseCsv, safeCsvCell, toCsv } from "@/domain/migration/csv";
import { mappingProblem, suggestMapping } from "@/domain/migration/fields";
import { mapAccountType, parseAmount, parseDate } from "@/domain/migration/normalize";
import { validateChartRows, validateContactRows, type ValidationContext } from "@/domain/migration/validators";

const ctx: ValidationContext = { baseCurrency: "AUD", existingAccountCodes: new Map([["1000", "Cash"]]), existingContactNames: new Set(["acme pty ltd"]) };
const rows = (cells: Record<string, string>[]) => cells.map((c, i) => ({ rowNumber: i + 2, cells: c }));

describe("CSV reader", () => {
  it("handles quotes, embedded commas and newlines, doubled quotes, CRLF and a BOM", () => {
    const p = parseCsv('﻿Code,Name\r\n1000,"Cash, at ""bank"""\r\n2000,"Line1\nLine2"\r\n');
    expect(p.headers).toEqual(["Code", "Name"]);
    expect(p.rows).toEqual([["1000", 'Cash, at "bank"'], ["2000", "Line1\nLine2"]]);
  });
  it("detects semicolon and tab delimiters outside quotes", () => {
    expect(parseCsv("a;b\n1;2").delimiter).toBe(";");
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
    expect(parseCsv('"a,b";c\n1;2').delimiter).toBe(";");
  });
  it("pads short rows, rejects long rows with data, skips blank lines", () => {
    expect(parseCsv("a,b,c\n1,2\n\n3,4,5").rows).toEqual([["1", "2", ""], ["3", "4", "5"]]);
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(CsvError);
    expect(parseCsv("a,b\n1,2,").rows).toEqual([["1", "2"]]);
  });
  it("refuses empty, binary, unterminated-quote, blank or duplicate headings and oversize input", () => {
    expect(() => parseCsv("   \n")).toThrow(/empty/);
    expect(() => parseCsv("a,b\n1,\u0000")).toThrow(/binary/);
    expect(() => parseCsv('a,b\n"1,2')).toThrow(/never closed/);
    expect(() => parseCsv("a,,c\n1,2,3")).toThrow(/blank/);
    expect(() => parseCsv("a,A\n1,2")).toThrow(/more than once/);
    expect(() => parseCsv("a\n" + "1\n".repeat(MAX_ROWS + 2))).toThrow(/more than/);
  });
  it("neutralises formulas on export but keeps negative numbers numeric", () => {
    expect(safeCsvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(safeCsvCell("+1+1")).toBe("'+1+1");
    expect(safeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(safeCsvCell("-12.50")).toBe("-12.50");
    expect(safeCsvCell("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(toCsv(["a"], [["=1+1"]])).toBe("a\r\n'=1+1\r\n");
  });
});

describe("value normalisers", () => {
  it("reads dates only in the chosen format and rejects impossible or two-digit-year dates", () => {
    expect(parseDate("03/04/2024", "DMY")).toEqual({ ok: true, value: "2024-04-03" });
    expect(parseDate("03/04/2024", "MDY")).toEqual({ ok: true, value: "2024-03-04" });
    expect(parseDate("2024/04/03", "YMD")).toEqual({ ok: true, value: "2024-04-03" });
    expect(parseDate("2024-02-29", "DMY").ok).toBe(true);
    expect(parseDate("15 Jan 2024", "MDY")).toEqual({ ok: true, value: "2024-01-15" });
    expect(parseDate("31/02/2024", "DMY").ok).toBe(false);
    expect(parseDate("13/13/2024", "MDY").ok).toBe(false);
    expect(parseDate("1/2/24", "DMY").ok).toBe(false);
    expect(parseDate("", "DMY").ok).toBe(false);
    expect(parseDate("2023-02-29", "YMD").ok).toBe(false);
  });
  it("parses amounts: symbols, thousands, brackets, trailing minus, decimal comma, and refuses ambiguity", () => {
    expect(parseAmount("$1,234.50")).toEqual({ ok: true, value: "1234.5000" });
    expect(parseAmount("(100)")).toEqual({ ok: true, value: "-100.0000" });
    expect(parseAmount("250.00-")).toEqual({ ok: true, value: "-250.0000" });
    expect(parseAmount("-0.1")).toEqual({ ok: true, value: "-0.1000" });
    expect(parseAmount("1.234,56", { decimalComma: true })).toEqual({ ok: true, value: "1234.5600" });
    expect(parseAmount("1.23456").ok).toBe(false);
    expect(parseAmount("12abc").ok).toBe(false);
    expect(parseAmount("").ok).toBe(false);
    expect(parseAmount("1e20").ok).toBe(false);
  });
  it("maps source account types by keyword, deterministically, and reports the unknown", () => {
    const t = (s: string) => {
      const r = mapAccountType(s);
      return r.ok ? r.value : null;
    };
    expect(t("Accounts Receivable")).toBe("ASSET");
    expect(t("Current Liability")).toBe("LIABILITY");
    expect(t("Accounts Payable")).toBe("LIABILITY");
    expect(t("Cost of Goods Sold")).toBe("EXPENSE");
    expect(t("Other Income")).toBe("REVENUE");
    expect(t("Prepaid Expenses")).toBe("ASSET");
    expect(t("Retained Earnings")).toBe("EQUITY");
    expect(t("Income Tax Payable")).toBe("LIABILITY");
    expect(t("Widget")).toBeNull();
    expect(mapAccountType("Widget", { widget: "expense" })).toEqual({ ok: true, value: "EXPENSE" });
  });
});

describe("column mapping", () => {
  it("pre-fills a mapping from common headings and claims each column once", () => {
    const m = suggestMapping("CHART_OF_ACCOUNTS", ["*Code", "*Name", "*Type", "*Tax Code", "Description"]);
    expect(m).toMatchObject({ code: "*Code", name: "*Name", type: "*Type", description: "Description" });
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });
  it("validates a mapping: required fields, unknown columns, a column used twice", () => {
    const headers = ["Code", "Name", "Type"];
    expect(mappingProblem("CHART_OF_ACCOUNTS", headers, { code: "Code", name: "Name", type: "Type" })).toBeNull();
    expect(mappingProblem("CHART_OF_ACCOUNTS", headers, { code: "Code", name: "Name" })).toMatch(/Account type/);
    expect(mappingProblem("CHART_OF_ACCOUNTS", headers, { code: "Code", name: "Nope", type: "Type" })).toMatch(/not in the file/);
    expect(mappingProblem("CHART_OF_ACCOUNTS", headers, { code: "Code", name: "Code", type: "Type" })).toMatch(/more than one/);
    expect(mappingProblem("CHART_OF_ACCOUNTS", headers, { code: "Code", name: "Name", type: "Type", bogus: "Code" })).toMatch(/not a field/);
  });
});

describe("row validation", () => {
  const map = { code: "Code", name: "Name", type: "Type" };
  it("flags bad rows with reasons, duplicates inside the file, and existing accounts", () => {
    const out = validateChartRows(
      rows([
        { Code: "4000", Name: "Sales", Type: "Income" },
        { Code: "4000", Name: "Sales 2", Type: "Income" },
        { Code: "", Name: "", Type: "Wibble" },
        { Code: "1000", Name: "Cash", Type: "Bank" },
      ]),
      map,
      {},
      ctx,
    );
    expect(out.map((r) => r.status)).toEqual(["VALID", "ERROR", "ERROR", "SKIPPED_DUPLICATE"]);
    expect(out[1]!.messages[0]).toMatch(/row 2/);
    expect(out[2]!.messages).toHaveLength(3);
    expect(out[0]!.normalized).toMatchObject({ code: "4000", type: "REVENUE", currency: "AUD" });
  });
  it("validates contacts: kind rules, email, defaults and duplicates", () => {
    const m = { displayName: "Name", kind: "Type", email: "Email" };
    const out = validateContactRows(
      rows([
        { Name: "Bob", Type: "Vendor", Email: "bob@example.com" },
        { Name: "Bob", Type: "Vendor", Email: "" },
        { Name: "Cy", Type: "", Email: "bad" },
        { Name: "Di", Type: "Alien", Email: "" },
        { Name: "ACME PTY LTD", Type: "Customer", Email: "" },
        { Name: "Ed", Type: "", Email: "" },
      ]),
      m,
      { defaultContactKind: "CUSTOMER" },
      ctx,
    );
    expect(out.map((r) => r.status)).toEqual(["VALID", "ERROR", "ERROR", "ERROR", "SKIPPED_DUPLICATE", "VALID"]);
    expect(out[0]!.normalized).toMatchObject({ kind: "SUPPLIER" });
    expect(out[5]!.normalized).toMatchObject({ kind: "CUSTOMER" });
  });
});
