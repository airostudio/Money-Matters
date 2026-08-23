import Decimal from "decimal.js";
import { StatementParseError } from "../errors";
import type { ParsedStatement, ParsedStatementRow } from "../types";
import { parseAmount, parseStatementDate, type DateOrder } from "./csv";

/**
 * QIF is line-oriented: each field is a one-letter code followed by its
 * value, one field per line, and `^` alone on a line ends a transaction.
 * D = date, T/U = amount (both mean the same thing; U is Quicken's newer
 * alias), P = payee, M = memo, N = check/reference number. Reused here:
 * `parseAmount`/`parseStatementDate` from the CSV parser, since QIF dates
 * and amounts are formatted exactly like the values a CSV cell would hold.
 */
export function parseQifStatement(text: string, dateOrder: DateOrder = "DMY"): ParsedStatement {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const warnings: string[] = [];
  const rows: ParsedStatementRow[] = [];

  let current: Record<string, string> = {};
  let sawAnyTransaction = false;
  let transactionIndex = 0;

  const flush = () => {
    if (Object.keys(current).length === 0) return;
    sawAnyTransaction = true;
    transactionIndex += 1;

    const dateRaw = current.D;
    const amountRaw = current.T ?? current.U;
    const date = dateRaw ? parseStatementDate(dateRaw, dateOrder) : null;
    const amount: Decimal | null = amountRaw ? parseAmount(amountRaw) : null;

    if (!date) {
      warnings.push(`Transaction ${transactionIndex}: missing or unparsable date — row skipped.`);
      current = {};
      return;
    }
    if (amount === null || amount.isZero()) {
      warnings.push(`Transaction ${transactionIndex}: missing or unparsable amount — row skipped.`);
      current = {};
      return;
    }

    const description = [current.P, current.M].filter(Boolean).join(" — ") || "(no description)";

    rows.push({
      postedDate: date,
      description,
      amount: amount.toFixed(4),
      raw: { ...current },
    });
    current = {};
  };

  for (const line of lines) {
    if (line.startsWith("!")) continue; // file/account type header, e.g. "!Type:Bank"
    if (line.trim() === "^") {
      flush();
      continue;
    }
    if (line.length === 0) continue;

    const code = line[0]!;
    const value = line.slice(1);
    current[code] = value;
  }
  flush(); // tolerate a file missing a trailing "^"

  if (!sawAnyTransaction) {
    throw new StatementParseError(
      "No transactions found — this doesn't look like a QIF bank statement export.",
    );
  }

  return { rows, warnings };
}
