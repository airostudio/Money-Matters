import type { MigrationKind } from "./fields";
import { cleanText, mapAccountType, validEmail, type DateFormat } from "./normalize";

/**
 * Pure per-kind row validation: raw cells + mapping + options -> normalised values, a natural key and plain-language
 * problems. No database access (the caller supplies what already exists in the books), so every rule is unit-testable.
 */

export interface MigrationOptions {
  dateFormat?: DateFormat;
  decimalComma?: boolean;
  /** CONTACTS: used when no column is mapped to customer/supplier (or the cell is blank). */
  defaultContactKind?: "CUSTOMER" | "SUPPLIER" | "BOTH";
  /** CHART_OF_ACCOUNTS: the user's own mapping of source type wording to a Money Matters type. */
  accountTypeMap?: Record<string, string>;
  /** Kind-specific extras (offset accounts, as-at date, ...), validated by the kind's own importer. */
  [key: string]: unknown;
}

export type StagedStatus = "VALID" | "ERROR" | "SKIPPED_DUPLICATE";

export interface StagedRow {
  rowNumber: number;
  raw: Record<string, string>;
  normalized: Record<string, unknown> | null;
  naturalKey: string | null;
  status: StagedStatus;
  /** For ERROR rows the reasons; for SKIPPED_DUPLICATE the explanation. */
  messages: string[];
}

export interface ValidationContext {
  baseCurrency: string;
  /** Existing account code -> name. */
  existingAccountCodes: ReadonlyMap<string, string>;
  /** Existing contact display name (lower case). */
  existingContactNames: ReadonlySet<string>;
}

export type RawRow = { rowNumber: number; cells: Record<string, string> };

function cell(row: RawRow, mapping: Record<string, string>, field: string): string {
  const header = mapping[field];
  return header ? (row.cells[header] ?? "") : "";
}

function finish(row: RawRow, normalized: Record<string, unknown>, key: string | null, errors: string[]): StagedRow {
  return {
    rowNumber: row.rowNumber,
    raw: row.cells,
    normalized: errors.length ? null : normalized,
    naturalKey: key,
    status: errors.length ? "ERROR" : "VALID",
    messages: errors,
  };
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,31}$/;

export function validateChartRows(
  rows: readonly RawRow[],
  mapping: Record<string, string>,
  options: MigrationOptions,
  ctx: ValidationContext,
): StagedRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const errors: string[] = [];
    const code = cleanText(cell(row, mapping, "code"), 64);
    const name = cleanText(cell(row, mapping, "name"), 300);
    if (code === "") errors.push("The account code is blank.");
    else if (!CODE_RE.test(code)) errors.push(`The account code "${code}" is not valid (letters, digits, . _ - / and spaces, at most 32 characters).`);
    if (name === "") errors.push("The account name is blank.");
    else if (name.length > 200) errors.push("The account name is longer than 200 characters.");
    const typeResult = mapAccountType(cell(row, mapping, "type"), options.accountTypeMap ?? {});
    if (!typeResult.ok) errors.push(typeResult.error);
    const currencyRaw = cleanText(cell(row, mapping, "currency"), 10).toUpperCase();
    if (currencyRaw !== "" && !/^[A-Z]{3}$/.test(currencyRaw)) errors.push(`The currency "${currencyRaw}" is not a 3-letter code.`);
    const key = code === "" ? null : code.toLowerCase();
    if (key) {
      const first = seen.get(key);
      if (first !== undefined) errors.push(`The account code "${code}" is already used by row ${first} of this file.`);
      else seen.set(key, row.rowNumber);
    }
    const result = finish(
      row,
      {
        code,
        name,
        type: typeResult.ok ? typeResult.value : null,
        subType: cleanText(cell(row, mapping, "subType"), 100) || null,
        description: cleanText(cell(row, mapping, "description"), 500) || null,
        currency: currencyRaw || ctx.baseCurrency,
      },
      key,
      errors,
    );
    if (result.status === "VALID" && ctx.existingAccountCodes.has(code)) {
      return { ...result, status: "SKIPPED_DUPLICATE", messages: [`An account with code ${code} ("${ctx.existingAccountCodes.get(code)}") already exists, so this row is left alone.`] };
    }
    return result;
  });
}

function contactKind(raw: string, fallback: MigrationOptions["defaultContactKind"]): "CUSTOMER" | "SUPPLIER" | "BOTH" | null {
  const k = raw.trim().toLowerCase();
  if (k === "") return fallback ?? null;
  if (/^(both|customer.*supplier|supplier.*customer|customer.*vendor|vendor.*customer)/.test(k)) return "BOTH";
  if (/^(customer|client|debtor)/.test(k)) return "CUSTOMER";
  if (/^(supplier|vendor|creditor)/.test(k)) return "SUPPLIER";
  return null;
}

export function validateContactRows(
  rows: readonly RawRow[],
  mapping: Record<string, string>,
  options: MigrationOptions,
  ctx: ValidationContext,
): StagedRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const errors: string[] = [];
    const displayName = cleanText(cell(row, mapping, "displayName"), 300);
    if (displayName === "") errors.push("The name is blank.");
    else if (displayName.length > 200) errors.push("The name is longer than 200 characters.");
    const kindRaw = cell(row, mapping, "kind");
    const kind = contactKind(kindRaw, options.defaultContactKind);
    if (!kind) {
      errors.push(kindRaw.trim() === "" ? "No customer/supplier value, and no default was chosen." : `"${kindRaw.trim()}" is not recognised as customer, supplier or both.`);
    }
    const email = cleanText(cell(row, mapping, "email"), 300);
    if (email !== "" && !validEmail(email)) errors.push(`"${email}" is not a valid email address.`);
    const currencyRaw = cleanText(cell(row, mapping, "currency"), 10).toUpperCase();
    if (currencyRaw !== "" && !/^[A-Z]{3}$/.test(currencyRaw)) errors.push(`The currency "${currencyRaw}" is not a 3-letter code.`);
    const address = {
      line1: cleanText(cell(row, mapping, "addressLine1"), 200),
      line2: cleanText(cell(row, mapping, "addressLine2"), 200),
      city: cleanText(cell(row, mapping, "city"), 100),
      state: cleanText(cell(row, mapping, "state"), 100),
      postcode: cleanText(cell(row, mapping, "postcode"), 20),
      country: cleanText(cell(row, mapping, "country"), 100),
    };
    const hasAddress = Object.values(address).some((v) => v !== "");
    const key = displayName === "" ? null : displayName.toLowerCase();
    if (key) {
      const first = seen.get(key);
      if (first !== undefined) errors.push(`"${displayName}" is already used by row ${first} of this file.`);
      else seen.set(key, row.rowNumber);
    }
    const result = finish(
      row,
      {
        displayName,
        kind,
        legalName: cleanText(cell(row, mapping, "legalName"), 200) || null,
        email: email || null,
        phone: cleanText(cell(row, mapping, "phone"), 50) || null,
        taxNumber: cleanText(cell(row, mapping, "taxNumber"), 50) || null,
        billingAddress: hasAddress ? address : null,
        currency: currencyRaw || ctx.baseCurrency,
      },
      key,
      errors,
    );
    if (result.status === "VALID" && key && ctx.existingContactNames.has(key)) {
      return { ...result, status: "SKIPPED_DUPLICATE", messages: [`A contact named "${displayName}" already exists, so this row is left alone.`] };
    }
    return result;
  });
}

export function validateRowsFor(
  kind: MigrationKind,
  rows: readonly RawRow[],
  mapping: Record<string, string>,
  options: MigrationOptions,
  ctx: ValidationContext,
): StagedRow[] {
  switch (kind) {
    case "CHART_OF_ACCOUNTS":
      return validateChartRows(rows, mapping, options, ctx);
    case "CONTACTS":
      return validateContactRows(rows, mapping, options, ctx);
    default:
      throw new Error(`Importer for ${kind} is not available yet.`);
  }
}
