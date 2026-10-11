/**
 * The target fields of each importer and the deterministic header matcher that pre-fills the column mapping.
 *
 * There is deliberately NO per-vendor preset (no "Xero chart of accounts" / "QuickBooks customers" button): no vendor's
 * exact export headings have been confirmed from two independent sources, and a preset that silently mis-maps a column
 * is worse than none. Every file goes through this one generic mapper; the user always sees and can change the mapping
 * before anything is imported (docs/migration.md).
 */

export const MIGRATION_KINDS = [
  "CHART_OF_ACCOUNTS",
  "CONTACTS",
  "OPENING_BALANCES",
  "OPEN_INVOICES",
  "OPEN_BILLS",
  "OPENING_STOCK",
] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

export function isMigrationKind(v: unknown): v is MigrationKind {
  return typeof v === "string" && (MIGRATION_KINDS as readonly string[]).includes(v);
}

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  /** Plausible column headings, matched after normalisation. Order does not matter. */
  aliases: readonly string[];
}

export const KIND_LABELS: Record<MigrationKind, string> = {
  CHART_OF_ACCOUNTS: "Chart of accounts",
  CONTACTS: "Customers and suppliers",
  OPENING_BALANCES: "Opening trial balance",
  OPEN_INVOICES: "Open customer invoices",
  OPEN_BILLS: "Open supplier bills",
  OPENING_STOCK: "Opening stock",
};

export const FIELDS: Record<MigrationKind, readonly FieldDef[]> = {
  CHART_OF_ACCOUNTS: [
    { key: "code", label: "Account code", required: true, aliases: ["code", "account code", "account number", "number", "account no", "acct no", "acct number", "gl code", "ledger code"] },
    { key: "name", label: "Account name", required: true, aliases: ["name", "account name", "account", "title", "account title", "description"] },
    { key: "type", label: "Account type", required: true, aliases: ["type", "account type", "class", "classification", "category", "group"] },
    { key: "subType", label: "Detail type / sub type", required: false, aliases: ["detail type", "sub type", "subtype", "account sub type", "subcategory"] },
    { key: "description", label: "Description", required: false, aliases: ["notes", "memo", "details", "account description"] },
    { key: "currency", label: "Currency", required: false, aliases: ["currency", "currency code", "ccy"] },
  ],
  CONTACTS: [
    { key: "displayName", label: "Name", required: true, aliases: ["contact name", "name", "display name", "customer", "supplier", "vendor", "company", "company name", "customer name", "supplier name", "vendor name", "contact"] },
    { key: "kind", label: "Customer / supplier", required: false, aliases: ["type", "contact type", "kind", "relationship"] },
    { key: "legalName", label: "Legal / trading name", required: false, aliases: ["legal name", "trading name", "business name", "registered name"] },
    { key: "email", label: "Email", required: false, aliases: ["email", "email address", "e-mail", "primary email"] },
    { key: "phone", label: "Phone", required: false, aliases: ["phone", "phone number", "telephone", "mobile", "tel"] },
    { key: "taxNumber", label: "Tax number (ABN / VAT / EIN)", required: false, aliases: ["tax number", "abn", "tax id", "vat number", "ein", "gst number", "tax no", "tax reg no"] },
    { key: "addressLine1", label: "Address line 1", required: false, aliases: ["address", "address line 1", "street", "address 1", "street address", "billing address"] },
    { key: "addressLine2", label: "Address line 2", required: false, aliases: ["address line 2", "address 2"] },
    { key: "city", label: "City / suburb", required: false, aliases: ["city", "suburb", "town", "locality"] },
    { key: "state", label: "State / region", required: false, aliases: ["state", "region", "province", "county"] },
    { key: "postcode", label: "Postcode", required: false, aliases: ["postcode", "post code", "postal code", "zip", "zip code"] },
    { key: "country", label: "Country", required: false, aliases: ["country", "country code"] },
    { key: "currency", label: "Currency", required: false, aliases: ["currency", "currency code", "ccy"] },
  ],
  OPENING_BALANCES: [
    { key: "accountCode", label: "Account code", required: false, aliases: ["code", "account code", "account number", "account no", "number", "acct no", "gl code"] },
    { key: "accountName", label: "Account name", required: false, aliases: ["account", "account name", "name", "description"] },
    { key: "debit", label: "Debit", required: false, aliases: ["debit", "debits", "dr", "debit amount"] },
    { key: "credit", label: "Credit", required: false, aliases: ["credit", "credits", "cr", "credit amount"] },
    { key: "balance", label: "Single signed balance (debit positive)", required: false, aliases: ["balance", "amount", "closing balance", "net", "ytd"] },
  ],
  OPEN_INVOICES: [
    { key: "contactName", label: "Customer name", required: true, aliases: ["customer", "contact", "contact name", "customer name", "name", "client"] },
    { key: "number", label: "Invoice number", required: true, aliases: ["invoice number", "invoice no", "invoice #", "number", "reference", "doc number", "invoice"] },
    { key: "issueDate", label: "Invoice date", required: true, aliases: ["date", "invoice date", "issue date", "issued", "transaction date"] },
    { key: "dueDate", label: "Due date", required: false, aliases: ["due date", "due", "payment due"] },
    { key: "amountDue", label: "Amount outstanding", required: true, aliases: ["balance", "amount due", "outstanding", "amount outstanding", "balance due", "open balance", "amount"] },
    { key: "memo", label: "Description / memo", required: false, aliases: ["memo", "description", "notes", "details"] },
  ],
  OPEN_BILLS: [
    { key: "contactName", label: "Supplier name", required: true, aliases: ["supplier", "vendor", "contact", "contact name", "supplier name", "vendor name", "name"] },
    { key: "number", label: "Bill number", required: true, aliases: ["bill number", "bill no", "bill #", "number", "reference", "invoice number", "supplier invoice", "doc number", "bill"] },
    { key: "issueDate", label: "Bill date", required: true, aliases: ["date", "bill date", "invoice date", "issue date", "transaction date"] },
    { key: "dueDate", label: "Due date", required: false, aliases: ["due date", "due", "payment due"] },
    { key: "amountDue", label: "Amount outstanding", required: true, aliases: ["balance", "amount due", "outstanding", "amount outstanding", "balance due", "open balance", "amount"] },
    { key: "memo", label: "Description / memo", required: false, aliases: ["memo", "description", "notes", "details"] },
  ],
  OPENING_STOCK: [
    { key: "sku", label: "SKU / item code", required: true, aliases: ["sku", "item code", "code", "product code", "item number", "part number", "item"] },
    { key: "name", label: "Item name", required: false, aliases: ["name", "item name", "product", "product name", "description", "item description"] },
    { key: "quantity", label: "Quantity on hand", required: true, aliases: ["quantity", "qty", "on hand", "quantity on hand", "qty on hand", "stock on hand", "stock"] },
    { key: "unitCost", label: "Unit cost", required: true, aliases: ["unit cost", "cost", "average cost", "avg cost", "cost price", "cost per unit"] },
  ],
};

export function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Suggests target field -> source column header. Deterministic: pass 1 takes exact (normalised) alias matches in field
 * order; pass 2 takes a header that contains an alias of 4+ letters (or is contained in it). A header is claimed at most
 * once. Fields with no confident match are left out; the user maps them by hand.
 */
export function suggestMapping(kind: MigrationKind, headers: readonly string[]): Record<string, string> {
  const fields = FIELDS[kind];
  const keyed = headers.map((h) => ({ header: h, key: headerKey(h) }));
  const claimed = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const f of fields) {
    const aliases = f.aliases.map(headerKey);
    const hit = keyed.find((h) => !claimed.has(h.header) && aliases.includes(h.key));
    if (hit) {
      mapping[f.key] = hit.header;
      claimed.add(hit.header);
    }
  }
  for (const f of fields) {
    if (mapping[f.key]) continue;
    const aliases = f.aliases.map(headerKey).filter((a) => a.length >= 4);
    const hit = keyed.find(
      (h) => !claimed.has(h.header) && h.key.length >= 4 && aliases.some((a) => h.key.includes(a) || a.includes(h.key)),
    );
    if (hit) {
      mapping[f.key] = hit.header;
      claimed.add(hit.header);
    }
  }
  return mapping;
}

/** Validates a user-supplied mapping against the real headers; returns a problem or null. */
export function mappingProblem(kind: MigrationKind, headers: readonly string[], mapping: Record<string, string>): string | null {
  const allowed = new Set(FIELDS[kind].map((f) => f.key));
  const used = new Set<string>();
  for (const [field, header] of Object.entries(mapping)) {
    if (!allowed.has(field)) return `"${field}" is not a field of this import.`;
    if (!headers.includes(header)) return `The column "${header}" is not in the file.`;
    if (used.has(header)) return `The column "${header}" is mapped to more than one field.`;
    used.add(header);
  }
  for (const f of FIELDS[kind]) if (f.required && !mapping[f.key]) return `Map a column to "${f.label}".`;
  return null;
}
