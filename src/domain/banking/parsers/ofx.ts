import Decimal from "decimal.js";
import { StatementParseError } from "../errors";
import type { ParsedStatement, ParsedStatementRow } from "../types";

/**
 * OFX comes in two incompatible-with-a-real-XML-parser flavors: OFX 1.x is
 * SGML, where leaf tags have no closing tag at all (`<TRNAMT>-45.00`, not
 * `<TRNAMT>-45.00</TRNAMT>`); OFX 2.x is proper XML. Rather than branch on
 * version, every field is read with a regex that stops at the next `<` or
 * newline — which happens to also be correct for the closing-tag case,
 * since the value still ends before the next `<`.
 */
function extractField(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return match ? match[1]!.trim() : null;
}

function extractBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/** OFX dates are YYYYMMDD[HHMMSS[.XXX]][[+-]TZ[:TZNAME]] — only the date part matters for a posting date. */
function parseOfxDate(raw: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export function parseOfxStatement(text: string): ParsedStatement {
  const transactionBlocks = extractBlocks(text, "STMTTRN");
  if (transactionBlocks.length === 0) {
    throw new StatementParseError(
      "No <STMTTRN> transactions found — this doesn't look like an OFX bank statement export.",
    );
  }

  const warnings: string[] = [];
  const rows: ParsedStatementRow[] = [];

  transactionBlocks.forEach((block, index) => {
    const dtPosted = extractField(block, "DTPOSTED");
    const trnAmt = extractField(block, "TRNAMT");
    const fitId = extractField(block, "FITID");
    const name = extractField(block, "NAME");
    const memo = extractField(block, "MEMO");
    const description = [name, memo].filter((v, i, arr) => v && arr.indexOf(v) === i).join(" — ");

    const postedDate = dtPosted ? parseOfxDate(dtPosted) : null;
    if (!postedDate) {
      warnings.push(`Transaction ${index + 1}: missing or unparsable DTPOSTED — row skipped.`);
      return;
    }

    let amount: Decimal;
    try {
      amount = new Decimal((trnAmt ?? "").trim());
    } catch {
      warnings.push(`Transaction ${index + 1}: missing or unparsable TRNAMT — row skipped.`);
      return;
    }
    if (amount.isZero()) {
      warnings.push(`Transaction ${index + 1}: TRNAMT is zero — row skipped.`);
      return;
    }

    rows.push({
      externalId: fitId ?? undefined,
      postedDate,
      description: description || "(no description)",
      amount: amount.toFixed(4),
      raw: {
        TRNTYPE: extractField(block, "TRNTYPE"),
        DTPOSTED: dtPosted,
        TRNAMT: trnAmt,
        FITID: fitId,
        NAME: name,
        MEMO: memo,
        CHECKNUM: extractField(block, "CHECKNUM"),
      },
    });
  });

  return { rows, warnings };
}
