import type { BankImportFormat } from "../types";
import { parseCsvStatement, type ParseCsvOptions } from "./csv";
import { parseOfxStatement } from "./ofx";
import { parseQifStatement } from "./qif";
import type { DateOrder } from "./csv";
import type { ParsedStatement } from "../types";

export { parseCsvStatement, parseAmount, parseStatementDate } from "./csv";
export { parseOfxStatement } from "./ofx";
export { parseQifStatement } from "./qif";
export type { CsvColumnMapping, ParseCsvOptions, DateOrder } from "./csv";

export interface ParseStatementOptions {
  csv?: ParseCsvOptions;
  dateOrder?: DateOrder;
}

/** Dispatches to the right parser by format — the single entry point `bank-import-service.ts` calls. */
export function parseStatement(
  format: BankImportFormat,
  text: string,
  options: ParseStatementOptions = {},
): ParsedStatement {
  switch (format) {
    case "CSV":
      return parseCsvStatement(text, options.csv);
    case "OFX":
      return parseOfxStatement(text);
    case "QIF":
      return parseQifStatement(text, options.dateOrder);
  }
}
