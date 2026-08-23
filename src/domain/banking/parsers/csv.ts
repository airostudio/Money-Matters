import Decimal from "decimal.js";
import { StatementParseError } from "../errors";
import type { ParsedStatement, ParsedStatementRow } from "../types";

/**
 * RFC4180-ish CSV tokenizer. Bank exports commonly quote fields containing
 * commas (an address, "Smith, John") or embedded quotes ("" escaping), which
 * a naive `line.split(",")` breaks on — this is the one place that matters
 * enough to write by hand rather than reach for a dependency.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalize line endings so \r\n and \r don't create phantom empty rows.
  const input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  // Trailing field/row not terminated by a final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

const DATE_COLUMN_NAMES = ["date", "transaction date", "posted date", "posting date"];
const DESCRIPTION_COLUMN_NAMES = ["description", "narrative", "memo", "details", "transaction details"];
const AMOUNT_COLUMN_NAMES = ["amount", "transaction amount"];
const DEBIT_COLUMN_NAMES = ["debit", "withdrawal", "debit amount", "money out"];
const CREDIT_COLUMN_NAMES = ["credit", "deposit", "credit amount", "money in"];
const BALANCE_COLUMN_NAMES = ["balance", "running balance", "balance after"];

function findColumn(header: string[], candidates: string[]): number {
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parses a decimal amount that may be prefixed with a currency symbol,
 * thousands-separated, or parenthesized for negative — all common in bank
 * exports ("$1,234.56", "(45.00)"). Never a float: this returns the exact
 * decimal.js value, converted to string immediately.
 */
export function parseAmount(raw: string): Decimal | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith("-");
  const cleaned = trimmed.replace(/^\(|\)$/g, "").replace(/^[-+]/, "").replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;

  try {
    const value = new Decimal(cleaned);
    return negative ? value.negated() : value;
  } catch {
    return null;
  }
}

export type DateOrder = "DMY" | "MDY";

/**
 * Australia (and most of the world) writes day before month; the US writes
 * month before day. An unambiguous ISO date is always trusted outright, and
 * a slash/dash date where the first segment is >12 is unambiguous the other
 * way regardless of what `order` says — `order` only decides genuinely
 * ambiguous dates like "03/04/2026".
 */
export function parseStatementDate(raw: string, order: DateOrder = "DMY"): Date | null {
  const trimmed = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  const slashOrDash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slashOrDash) {
    const [, a, b, y] = slashOrDash;
    const first = Number(a);
    const second = Number(b);
    const [day, month] =
      first > 12 ? [first, second] : second > 12 ? [second, first] : order === "DMY" ? [first, second] : [second, first];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(Number(y), month - 1, day));
  }

  return null;
}

export interface CsvColumnMapping {
  date: string;
  description: string;
  /** Either a single signed-amount column, or separate debit/credit columns. */
  amount?: string;
  debit?: string;
  credit?: string;
  balance?: string;
}

export interface ParseCsvOptions {
  /** Explicit header-name mapping. When omitted, common header names are auto-detected. */
  mapping?: CsvColumnMapping;
  dateOrder?: DateOrder;
}

/**
 * Parses a bank-exported CSV into normalized rows. Bank CSV exports have no
 * standard schema — this either auto-detects common column names or uses an
 * explicit mapping the importing user confirmed (the UI shows a preview with
 * detected columns before committing an import).
 */
export function parseCsvStatement(text: string, options: ParseCsvOptions = {}): ParsedStatement {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new StatementParseError("The file is empty.");
  }

  const [header, ...dataRows] = rows;
  const warnings: string[] = [];

  const dateCol = options.mapping
    ? header!.findIndex((h) => h.trim() === options.mapping!.date)
    : findColumn(header!, DATE_COLUMN_NAMES);
  const descriptionCol = options.mapping
    ? header!.findIndex((h) => h.trim() === options.mapping!.description)
    : findColumn(header!, DESCRIPTION_COLUMN_NAMES);
  const amountCol = options.mapping?.amount
    ? header!.findIndex((h) => h.trim() === options.mapping!.amount)
    : options.mapping
      ? -1
      : findColumn(header!, AMOUNT_COLUMN_NAMES);
  const debitCol = options.mapping?.debit
    ? header!.findIndex((h) => h.trim() === options.mapping!.debit)
    : options.mapping
      ? -1
      : findColumn(header!, DEBIT_COLUMN_NAMES);
  const creditCol = options.mapping?.credit
    ? header!.findIndex((h) => h.trim() === options.mapping!.credit)
    : options.mapping
      ? -1
      : findColumn(header!, CREDIT_COLUMN_NAMES);
  const balanceCol = options.mapping?.balance
    ? header!.findIndex((h) => h.trim() === options.mapping!.balance)
    : findColumn(header!, BALANCE_COLUMN_NAMES);

  if (dateCol < 0) {
    throw new StatementParseError(
      "Could not find a date column. Expected a header like \"Date\" or \"Transaction Date\".",
    );
  }
  if (descriptionCol < 0) {
    throw new StatementParseError(
      "Could not find a description column. Expected a header like \"Description\" or \"Narrative\".",
    );
  }
  if (amountCol < 0 && (debitCol < 0 || creditCol < 0)) {
    throw new StatementParseError(
      "Could not find an amount column, or a debit/credit pair. Expected a header like \"Amount\", or both \"Debit\" and \"Credit\".",
    );
  }

  const parsedRows: ParsedStatementRow[] = [];
  const dateOrder = options.dateOrder ?? "DMY";

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2; // account for the header row, 1-indexed for humans
    if (row.every((cell) => cell.trim() === "")) return;

    const dateValue = row[dateCol]?.trim() ?? "";
    const date = parseStatementDate(dateValue, dateOrder);
    if (!date) {
      warnings.push(`Row ${rowNumber}: could not parse date "${dateValue}" — row skipped.`);
      return;
    }

    const description = row[descriptionCol]?.trim() ?? "";

    let amount: Decimal | null;
    if (amountCol >= 0) {
      amount = parseAmount(row[amountCol] ?? "");
    } else {
      const debit = parseAmount(row[debitCol] ?? "") ?? new Decimal(0);
      const credit = parseAmount(row[creditCol] ?? "") ?? new Decimal(0);
      amount = credit.minus(debit.abs());
    }
    if (amount === null || amount.isZero()) {
      warnings.push(`Row ${rowNumber}: could not parse a non-zero amount — row skipped.`);
      return;
    }

    const balanceRaw = balanceCol >= 0 ? row[balanceCol] : undefined;
    const balance = balanceRaw ? parseAmount(balanceRaw) : null;

    const raw: Record<string, unknown> = {};
    header!.forEach((h, i) => {
      raw[h.trim() || `column_${i}`] = row[i] ?? "";
    });

    parsedRows.push({
      postedDate: date,
      description: description || "(no description)",
      amount: amount.toFixed(4),
      balanceAfter: balance ? balance.toFixed(4) : undefined,
      raw,
    });
  });

  return { rows: parsedRows, warnings };
}
