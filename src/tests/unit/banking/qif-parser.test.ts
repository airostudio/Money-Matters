import { describe, expect, it } from "vitest";
import { parseQifStatement } from "@/domain/banking/parsers/qif";
import { StatementParseError } from "@/domain/banking/errors";

const QIF = `!Type:Bank
D15/01/2026
T-45.00
PCoffee Shop
MMorning coffee
^
D16/01/2026
U2500.00
PEmployer
^
`;

describe("parseQifStatement", () => {
  it("parses transactions separated by ^", () => {
    const result = parseQifStatement(QIF);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ amount: "-45.0000", description: "Coffee Shop — Morning coffee" });
    expect(result.rows[0]?.postedDate.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("treats the U field as an amount alias for T", () => {
    const result = parseQifStatement(QIF);
    expect(result.rows[1]).toMatchObject({ amount: "2500.0000", description: "Employer" });
  });

  it("tolerates a missing trailing ^", () => {
    const noTrailingCaret = "D15/01/2026\nT-10.00\nPTest";
    const result = parseQifStatement(noTrailingCaret);
    expect(result.rows).toHaveLength(1);
  });

  it("skips a transaction with no date and reports why", () => {
    const broken = "T-10.00\nPTest\n^\nD16/01/2026\nT5.00\nPOk\n^\n";
    const result = parseQifStatement(broken);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/date/i);
  });

  it("throws a StatementParseError when the file has no transactions at all", () => {
    expect(() => parseQifStatement("!Type:Bank\n")).toThrow(StatementParseError);
  });
});
