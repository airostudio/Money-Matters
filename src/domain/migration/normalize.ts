import Decimal from "decimal.js";

/** Value normalisers shared by every importer. Each returns a result or a plain-language reason it could not. */

export type DateFormat = "DMY" | "MDY" | "YMD";
export const DATE_FORMATS: readonly DateFormat[] = ["DMY", "MDY", "YMD"];

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parses a calendar date in the format the USER chose (never guessed: 03/04/2024 is 3 April or March 4 depending on the
 * source system, and a wrong guess silently moves money between periods). An unambiguous ISO date (YYYY-MM-DD) and a
 * day-month-name date (15 Jan 2024) are accepted under any setting. Two-digit years are refused. Returns YYYY-MM-DD.
 */
export function parseDate(raw: string, format: DateFormat): Parsed<string> {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "The date is blank." };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (m) {
    const iso = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${text}" is not a real calendar date.` };
  }
  m = /^(\d{1,2})[ \-/]([A-Za-z]{3,9})[ \-/,]+(\d{4})$/.exec(text);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const iso = mi >= 0 ? validDate(Number(m[3]), mi + 1, Number(m[1])) : null;
    return iso ? { ok: true, value: iso } : { ok: false, error: `"${text}" is not a real calendar date.` };
  }
  m = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/.exec(text);
  if (!m) return { ok: false, error: `"${text}" is not a date in a format Money Matters can read.` };
  const [a, b, c] = [m[1]!, m[2]!, m[3]!];
  let y: string;
  let mo: string;
  let d: string;
  if (format === "YMD") [y, mo, d] = [a, b, c];
  else if (format === "DMY") [d, mo, y] = [a, b, c];
  else [mo, d, y] = [a, b, c];
  if (y.length !== 4) return { ok: false, error: `"${text}" has a two-digit year. Use four digits, or re-export the file with four-digit years.` };
  const iso = validDate(Number(y), Number(mo), Number(d));
  return iso
    ? { ok: true, value: iso }
    : { ok: false, error: `"${text}" is not a real date when read as ${format === "DMY" ? "day/month/year" : format === "MDY" ? "month/day/year" : "year/month/day"}.` };
}

/**
 * Parses a money amount to a plain decimal string with at most 4 decimal places (the ledger's precision). Accepts
 * thousands separators, a leading currency symbol, (brackets) or a trailing minus for negatives. `decimalComma` reads
 * 1.234,56 the European way. More than 4 decimal places is refused rather than rounded: a silent rounding in an opening
 * balance is exactly the kind of difference this tool exists to surface.
 */
export function parseAmount(raw: string, opts: { decimalComma?: boolean } = {}): Parsed<string> {
  let s = raw.trim();
  if (s === "") return { ok: false, error: "The amount is blank." };
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  s = s.replace(/^[$£€]\s*/, "").replace(/\s/g, "");
  s = opts.decimalComma ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return { ok: false, error: `"${raw.trim()}" is not a number.` };
  let value: Decimal;
  try {
    value = new Decimal(s);
  } catch {
    return { ok: false, error: `"${raw.trim()}" is not a number.` };
  }
  if (value.decimalPlaces() > 4) return { ok: false, error: `"${raw.trim()}" has more than 4 decimal places.` };
  if (value.abs().gte("1e15")) return { ok: false, error: `"${raw.trim()}" is too large.` };
  if (negative) value = value.negated();
  return { ok: true, value: value.toFixed(4) };
}

export type AccountTypeValue = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export const ACCOUNT_TYPES: readonly AccountTypeValue[] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];

/** Normalises a type cell for lookup in the user's own value map: lower case, single spaces. */
export function typeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Maps a source system's account type wording ("Accounts Receivable", "Cost of Goods Sold", "Other Income", ...) to one
 * of the five Money Matters types by keyword, in a fixed order so the answer is deterministic. The user's own value map
 * wins over this; anything unrecognised is reported (never guessed) so the user can map it.
 */
export function mapAccountType(raw: string, userMap: Readonly<Record<string, string>> = {}): Parsed<AccountTypeValue> {
  const key = typeKey(raw);
  if (key === "") return { ok: false, error: "The account type is blank." };
  const mapped = userMap[key]?.toUpperCase();
  if (mapped && (ACCOUNT_TYPES as readonly string[]).includes(mapped)) return { ok: true, value: mapped as AccountTypeValue };
  const rules: [RegExp, AccountTypeValue][] = [
    [/liabilit|payable|credit card|loan|\bgst collected|\bgst payable/, "LIABILITY"],
    [/prepa|receivable|inventor|stock on hand|\bbank\b|\bcash\b|fixed asset|accumulated dep/, "ASSET"],
    [/equity|retained|owner|capital|drawings|shareholder/, "EQUITY"],
    [/expense|cost of|cogs|overhead|depreciation|direct cost|purchases/, "EXPENSE"],
    [/revenue|income|sales|turnover|fees earned/, "REVENUE"],
    [/asset/, "ASSET"],
  ];
  for (const [re, type] of rules) if (re.test(key)) return { ok: true, value: type };
  return { ok: false, error: `The account type "${raw.trim()}" is not one Money Matters recognises. Map it to Asset, Liability, Equity, Revenue or Expense.` };
}

export function cleanText(raw: string | undefined, max = 200): string {
  return (raw ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export function validEmail(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s);
}
