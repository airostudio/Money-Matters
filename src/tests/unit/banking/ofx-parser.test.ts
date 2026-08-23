import { describe, expect, it } from "vitest";
import { parseOfxStatement } from "@/domain/banking/parsers/ofx";
import { StatementParseError } from "@/domain/banking/errors";

const SGML_OFX = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115120000
<TRNAMT>-45.00
<FITID>20260115001
<NAME>Coffee Shop
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260116
<TRNAMT>2500.00
<FITID>20260116001
<NAME>Employer
<MEMO>Salary
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const XML_OFX = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260115</DTPOSTED>
            <TRNAMT>-45.00</TRNAMT>
            <FITID>xml-1</FITID>
            <NAME>Coffee Shop</NAME>
          </STMTTRN>
        </BANKTRANLIST>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

describe("parseOfxStatement", () => {
  it("parses OFX 1.x SGML (unclosed leaf tags)", () => {
    const result = parseOfxStatement(SGML_OFX);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      externalId: "20260115001",
      description: "Coffee Shop",
      amount: "-45.0000",
    });
    expect(result.rows[0]?.postedDate.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("combines NAME and MEMO into the description when both are present", () => {
    const result = parseOfxStatement(SGML_OFX);
    expect(result.rows[1]?.description).toBe("Employer — Salary");
  });

  it("parses OFX 2.x XML (closed tags)", () => {
    const result = parseOfxStatement(XML_OFX);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ externalId: "xml-1", amount: "-45.0000" });
  });

  it("uses FITID as the external id, not a content hash", () => {
    const result = parseOfxStatement(SGML_OFX);
    expect(result.rows[0]?.externalId).toBe("20260115001");
  });

  it("throws a StatementParseError when there are no STMTTRN blocks", () => {
    expect(() => parseOfxStatement("<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>")).toThrow(StatementParseError);
  });

  it("skips a transaction missing DTPOSTED and reports why", () => {
    const broken = `<OFX><STMTTRN><TRNAMT>-1.00<FITID>x</STMTTRN></OFX>`;
    const result = parseOfxStatement(broken);
    expect(result.rows).toHaveLength(0);
    expect(result.warnings[0]).toMatch(/DTPOSTED/);
  });
});
