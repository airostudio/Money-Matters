import Decimal from "decimal.js";

/**
 * Wire formats. Everything the API returns goes through an explicit mapper in this file - NEVER a raw database
 * row - so internal columns (organization_id, created_by/updated_by ids, optimistic-edit versions, hashes) can't
 * leak by accident and renaming a column can't silently change the contract.
 *
 *  - MONEY is `{ "amount": "1234.50", "currency": "AUD" }`: a decimal STRING plus an explicit currency code,
 *    never a JSON number (JavaScript floats cannot represent decimal money). Amounts are normalised to at least 2
 *    and at most 4 decimal places (the ledger's scale), by decimal.js, never by Number().
 *  - DATES are `YYYY-MM-DD` (a calendar date: issue_date, due_date, payment_date, posting_date) and TIMESTAMPS are
 *    RFC 3339 UTC with milliseconds (`created_at`, `posted_at`). The two are never interchanged.
 *  - Field names are snake_case.
 */
export interface MoneyDto {
  amount: string;
  currency: string;
}

/** Normalises a decimal string to 2-4 decimal places without ever passing through a float. */
export function decimalString(value: string, maxPlaces = 4): string {
  let fixed = new Decimal(value).toFixed(maxPlaces);
  while (fixed.endsWith("0") && /\.\d{3,}$/.test(fixed)) fixed = fixed.slice(0, -1);
  return fixed;
}

export function money(amount: string, currency: string): MoneyDto {
  return { amount: decimalString(amount), currency };
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isoTimestamp(date: Date): string {
  return date.toISOString();
}

export function isoTimestampOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---- Contacts -------------------------------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  kind: string;
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
  billingAddress: unknown;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function contactDto(row: ContactRow) {
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.displayName,
    legal_name: row.legalName,
    email: row.email,
    phone: row.phone,
    tax_number: row.taxNumber,
    billing_address: (row.billingAddress ?? null) as Record<string, unknown> | null,
    currency: row.currency,
    is_active: row.isActive,
    created_at: isoTimestamp(row.createdAt),
    updated_at: isoTimestamp(row.updatedAt),
  };
}

// ---- Accounts -------------------------------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  subType: string | null;
  currency: string;
  isControlAccount: boolean;
  isActive: boolean;
  description: string | null;
  parentAccountId: string | null;
  createdAt: Date;
}

export function accountDto(row: AccountRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    sub_type: row.subType,
    currency: row.currency,
    is_control_account: row.isControlAccount,
    is_active: row.isActive,
    description: row.description,
    parent_account_id: row.parentAccountId,
    created_at: isoTimestamp(row.createdAt),
  };
}

// ---- Invoices and bills -----------------------------------------------------------------------------------------

export interface DocumentLineRow {
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string | null;
  lineAmount: string;
  taxAmount: string;
}

export function documentLineDto(row: DocumentLineRow, currency: string) {
  return {
    line_number: row.lineNumber,
    description: row.description,
    quantity: decimalString(row.quantity),
    unit_price: money(row.unitPrice, currency),
    account_id: row.accountId,
    tax_code_id: row.taxCodeId,
    line_amount: money(row.lineAmount, currency),
    tax_amount: money(row.taxAmount, currency),
  };
}

export interface DocumentRow {
  id: string;
  number: string;
  status: string;
  counterpartyId: string;
  counterpartyName: string;
  issueDate: Date;
  dueDate: Date;
  currency: string;
  memo: string | null;
  reference: string | null;
  controlAccountId: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  postedAt: Date | null;
  createdAt: Date;
  lines?: DocumentLineRow[];
}

/** Shared shape of an invoice (counterparty key `customer`) or a bill (`supplier`). */
function documentBase(row: DocumentRow) {
  const paid = new Decimal(row.amountPaid);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    issue_date: isoDate(row.issueDate),
    due_date: isoDate(row.dueDate),
    currency: row.currency,
    memo: row.memo,
    subtotal: money(row.subtotal, row.currency),
    tax_total: money(row.taxTotal, row.currency),
    total: money(row.total, row.currency),
    amount_paid: money(row.amountPaid, row.currency),
    amount_due: money(new Decimal(row.total).minus(paid).toString(), row.currency),
    posted_at: isoTimestampOrNull(row.postedAt),
    created_at: isoTimestamp(row.createdAt),
  };
}

export function invoiceDto(row: DocumentRow) {
  return {
    ...documentBase(row),
    customer: { id: row.counterpartyId, display_name: row.counterpartyName },
    ar_account_id: row.controlAccountId,
    ...(row.lines ? { lines: row.lines.map((l) => documentLineDto(l, row.currency)) } : {}),
  };
}

export function billDto(row: DocumentRow) {
  return {
    ...documentBase(row),
    supplier: { id: row.counterpartyId, display_name: row.counterpartyName },
    supplier_reference: row.reference,
    ap_account_id: row.controlAccountId,
    ...(row.lines ? { lines: row.lines.map((l) => documentLineDto(l, row.currency)) } : {}),
  };
}

// ---- Payments ---------------------------------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  paymentDate: Date;
  amount: string;
  currency: string;
  method: string;
  reference: string | null;
  createdAt: Date;
  allocations?: { documentId: string; documentNumber: string; amount: string }[];
}

function paymentBase(row: PaymentRow) {
  return {
    id: row.id,
    payment_date: isoDate(row.paymentDate),
    amount: money(row.amount, row.currency),
    method: row.method,
    reference: row.reference,
    created_at: isoTimestamp(row.createdAt),
  };
}

export function paymentDto(row: PaymentRow) {
  return {
    ...paymentBase(row),
    customer: { id: row.counterpartyId, display_name: row.counterpartyName },
    ...(row.allocations
      ? { allocations: row.allocations.map((a) => ({ invoice_id: a.documentId, invoice_number: a.documentNumber, amount: money(a.amount, row.currency) })) }
      : {}),
  };
}

export function supplierPaymentDto(row: PaymentRow) {
  return {
    ...paymentBase(row),
    supplier: { id: row.counterpartyId, display_name: row.counterpartyName },
    ...(row.allocations
      ? { allocations: row.allocations.map((a) => ({ bill_id: a.documentId, bill_number: a.documentNumber, amount: money(a.amount, row.currency) })) }
      : {}),
  };
}

// ---- Journals ---------------------------------------------------------------------------------------------------

export interface JournalLineRow {
  lineNumber: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  memo: string | null;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
}

export interface JournalRow {
  id: string;
  entryNumber: string;
  postingDate: Date;
  memo: string | null;
  status: string;
  sourceType: string;
  postedAt: Date | null;
  createdAt: Date;
  baseCurrency: string;
  lines?: JournalLineRow[];
}

export function journalDto(row: JournalRow) {
  return {
    id: row.id,
    entry_number: row.entryNumber,
    posting_date: isoDate(row.postingDate),
    memo: row.memo,
    status: row.status,
    source_type: row.sourceType,
    base_currency: row.baseCurrency,
    posted_at: isoTimestampOrNull(row.postedAt),
    created_at: isoTimestamp(row.createdAt),
    ...(row.lines
      ? {
          lines: row.lines.map((l) => ({
            line_number: l.lineNumber,
            account: { id: l.accountId, code: l.accountCode, name: l.accountName },
            memo: l.memo,
            currency: l.currency,
            exchange_rate: decimalString(l.exchangeRate, 8),
            debit: money(l.debit, l.currency),
            credit: money(l.credit, l.currency),
            base_debit: money(l.baseDebit, row.baseCurrency),
            base_credit: money(l.baseCredit, row.baseCurrency),
          })),
        }
      : {}),
  };
}
