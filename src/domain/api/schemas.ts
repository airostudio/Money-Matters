import { z } from "zod/v4";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./cursor";

/**
 * Every request and response shape of the public API, as zod schemas. They do three jobs from ONE definition:
 *  1. strictly VALIDATE input (every object is `strictObject`: an unknown field is a 422, never silently ignored);
 *  2. generate the OpenAPI 3.1 document (src/domain/api/openapi.ts), so the spec cannot drift from the code;
 *  3. let tests check that what the endpoints actually return conforms to the documented shape.
 * Money is a decimal STRING plus a currency (never a number); a date is `YYYY-MM-DD`, a timestamp RFC 3339.
 */

// ---- Primitives -------------------------------------------------------------------------------------------------

export const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Must be a UUID.").meta({ format: "uuid" });

/** A calendar date, `YYYY-MM-DD`, that really exists (2026-02-30 is rejected). */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Not a real calendar date.")
  .meta({ format: "date", example: "2026-03-31" });

export const timestampString = z.string().meta({ format: "date-time", example: "2026-03-31T09:30:00.000Z" });

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 currency code, e.g. AUD.").meta({ example: "AUD" });

/** A non-negative decimal as a STRING with at most 4 decimal places. A JSON number is rejected on purpose. */
export const decimalInput = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "Must be a non-negative decimal string with at most 4 decimal places, e.g. \"150.00\".")
  .meta({ example: "150.00" });

const decimalOut = z.string().meta({ pattern: "^-?\\d+\\.\\d{2,8}$", example: "1234.50" });

export const Money = z.strictObject({ amount: decimalOut, currency: currencyCode }).meta({ id: "Money", description: "A decimal amount as a string, with its currency." });

/** Parses a validated `YYYY-MM-DD` into the UTC-midnight Date the domain services expect. */
export const toUtcDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

// ---- Query parameters --------------------------------------------------------------------------------------------

const limitParam = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).meta({ description: `Page size, 1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).` });
const cursorParam = z.string().min(1).max(600).optional().meta({ description: "Opaque cursor from the previous page's `next_cursor`." });
const boolParam = z.enum(["true", "false"]).transform((v) => v === "true");

export const pageQuery = { limit: limitParam, cursor: cursorParam };

export const ContactListQuery = z.strictObject({ ...pageQuery, include_inactive: boolParam.optional() });
export const AccountListQuery = z.strictObject({
  ...pageQuery,
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]).optional(),
  include_inactive: boolParam.optional(),
});
export const InvoiceListQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(["DRAFT", "APPROVED", "SENT", "VIEWED", "PART_PAID", "PAID", "VOID"]).optional(),
  customer_id: uuid.optional(),
  issue_date_from: dateString.optional(),
  issue_date_to: dateString.optional(),
});
export const BillListQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(["DRAFT", "APPROVED", "PART_PAID", "PAID", "VOID"]).optional(),
  supplier_id: uuid.optional(),
  issue_date_from: dateString.optional(),
  issue_date_to: dateString.optional(),
});
export const ReceiptListQuery = z.strictObject({
  ...pageQuery,
  customer_id: uuid.optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
});
export const SupplierPaymentListQuery = z.strictObject({
  ...pageQuery,
  supplier_id: uuid.optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
});
export const JournalListQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(["DRAFT", "POSTED", "REVERSED"]).optional(),
  date_from: dateString.optional(),
  date_to: dateString.optional(),
});
export const ProfitAndLossQuery = z.strictObject({ from: dateString, to: dateString });
export const BalanceSheetQuery = z.strictObject({ as_of: dateString.optional() });
export const TrialBalanceQuery = z.strictObject({ as_of: dateString.optional() });
export const NoQuery = z.strictObject({});

// ---- Request bodies ---------------------------------------------------------------------------------------------

const address = z.strictObject({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postcode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
});

const contactBody = {
  display_name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Must be an email address.").optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  tax_number: z.string().trim().min(1).max(40).optional(),
  billing_address: address.optional(),
  currency: currencyCode,
};
export const CreateCustomerBody = z.strictObject(contactBody).meta({ id: "CreateCustomerRequest" });
export const CreateSupplierBody = z.strictObject(contactBody).meta({ id: "CreateSupplierRequest" });

const lineBody = z.strictObject({
  description: z.string().trim().min(1).max(500),
  quantity: decimalInput.meta({ description: "Greater than zero." }),
  unit_price: decimalInput,
  account_id: uuid.meta({ description: "The revenue (invoice) or expense/asset (bill) account for this line." }),
  tax_code_id: uuid.optional(),
});

function documentBody<T extends Record<string, z.ZodType>>(extra: T) {
  return z
    .strictObject({
      issue_date: dateString,
      due_date: dateString,
      currency: currencyCode,
      memo: z.string().max(1000).optional(),
      lines: z.array(lineBody).min(1).max(100),
      ...extra,
    })
    .refine((v) => (v as unknown as { due_date: string; issue_date: string }).due_date >= (v as unknown as { issue_date: string }).issue_date, { message: "due_date must not be before issue_date.", path: ["due_date"] });
}

export const CreateInvoiceBody = documentBody({
  customer_id: uuid,
  ar_account_id: uuid.meta({ description: "The Accounts Receivable control account this invoice will post to." }),
}).meta({ id: "CreateInvoiceRequest" });

export const CreateBillBody = documentBody({
  supplier_id: uuid,
  ap_account_id: uuid.meta({ description: "The Accounts Payable control account this bill will post to." }),
  supplier_reference: z.string().trim().min(1).max(100).optional(),
}).meta({ id: "CreateBillRequest" });

// ---- Response shapes ---------------------------------------------------------------------------------------------

const nullableString = z.string().nullable();

export const ContactOut = z
  .strictObject({
    id: uuid,
    kind: z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]),
    display_name: z.string(),
    legal_name: nullableString,
    email: nullableString,
    phone: nullableString,
    tax_number: nullableString,
    billing_address: z.record(z.string(), z.unknown()).nullable(),
    currency: currencyCode,
    is_active: z.boolean(),
    created_at: timestampString,
    updated_at: timestampString,
  })
  .meta({ id: "Contact" });

export const AccountOut = z
  .strictObject({
    id: uuid,
    code: z.string(),
    name: z.string(),
    type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
    sub_type: nullableString,
    currency: currencyCode,
    is_control_account: z.boolean(),
    is_active: z.boolean(),
    description: nullableString,
    parent_account_id: uuid.nullable(),
    created_at: timestampString,
  })
  .meta({ id: "Account" });

const LineOut = z.strictObject({
  line_number: z.number().int(),
  description: z.string(),
  quantity: z.string(),
  unit_price: Money,
  account_id: uuid,
  tax_code_id: uuid.nullable(),
  line_amount: Money,
  tax_amount: Money,
});

const documentOut = {
  id: uuid,
  number: z.string(),
  issue_date: dateString,
  due_date: dateString,
  currency: currencyCode,
  memo: nullableString,
  subtotal: Money,
  tax_total: Money,
  total: Money,
  amount_paid: Money,
  amount_due: Money,
  posted_at: timestampString.nullable(),
  created_at: timestampString,
  lines: z.array(LineOut).optional(),
};
const party = z.strictObject({ id: uuid, display_name: z.string() });

export const InvoiceOut = z
  .strictObject({
    ...documentOut,
    status: z.enum(["DRAFT", "APPROVED", "SENT", "VIEWED", "PART_PAID", "PAID", "VOID"]),
    customer: party,
    ar_account_id: uuid,
  })
  .meta({ id: "Invoice", description: "`lines` is present on single-invoice responses and absent from list items." });

export const BillOut = z
  .strictObject({
    ...documentOut,
    status: z.enum(["DRAFT", "APPROVED", "PART_PAID", "PAID", "VOID"]),
    supplier: party,
    supplier_reference: nullableString,
    ap_account_id: uuid,
  })
  .meta({ id: "Bill", description: "`lines` is present on single-bill responses and absent from list items." });

const paymentCommon = {
  id: uuid,
  payment_date: dateString,
  amount: Money,
  method: z.enum(["BANK_TRANSFER", "CASH", "CARD", "CHEQUE", "OTHER"]),
  reference: nullableString,
  created_at: timestampString,
};

export const ReceiptOut = z
  .strictObject({
    ...paymentCommon,
    customer: party,
    allocations: z.array(z.strictObject({ invoice_id: uuid, invoice_number: z.string(), amount: Money })).optional(),
  })
  .meta({ id: "Payment", description: "A payment received from a customer. `allocations` is present on single-payment responses." });

export const SupplierPaymentOut = z
  .strictObject({
    ...paymentCommon,
    supplier: party,
    allocations: z.array(z.strictObject({ bill_id: uuid, bill_number: z.string(), amount: Money })).optional(),
  })
  .meta({ id: "SupplierPayment", description: "A payment made to a supplier. `allocations` is present on single-payment responses." });

export const JournalOut = z
  .strictObject({
    id: uuid,
    entry_number: z.string(),
    posting_date: dateString,
    memo: nullableString,
    status: z.enum(["DRAFT", "POSTED", "REVERSED"]),
    source_type: z.string(),
    base_currency: currencyCode,
    posted_at: timestampString.nullable(),
    created_at: timestampString,
    lines: z
      .array(
        z.strictObject({
          line_number: z.number().int(),
          account: z.strictObject({ id: uuid, code: z.string(), name: z.string() }),
          memo: nullableString,
          currency: currencyCode,
          exchange_rate: z.string(),
          debit: Money,
          credit: Money,
          base_debit: Money,
          base_credit: Money,
        }),
      )
      .optional(),
  })
  .meta({ id: "JournalEntry", description: "`lines` is present on single-entry responses." });

const reportLine = z.strictObject({ account_id: uuid.nullable(), code: nullableString, name: z.string(), amount: Money });

export const ProfitAndLossOut = z
  .strictObject({
    from: dateString,
    to: dateString,
    currency: currencyCode,
    revenue: z.array(reportLine),
    total_revenue: Money,
    expenses: z.array(reportLine),
    total_expenses: Money,
    net_profit: Money,
  })
  .meta({ id: "ProfitAndLoss" });

export const BalanceSheetOut = z
  .strictObject({
    as_of: dateString,
    currency: currencyCode,
    assets: z.array(reportLine),
    total_assets: Money,
    liabilities: z.array(reportLine),
    total_liabilities: Money,
    equity: z.array(reportLine),
    total_equity: Money,
    total_liabilities_and_equity: Money,
    difference: Money,
    is_balanced: z.boolean(),
  })
  .meta({ id: "BalanceSheet" });

export const TrialBalanceOut = z
  .strictObject({
    as_of: dateString,
    currency: currencyCode,
    rows: z.array(
      z.strictObject({
        account_id: uuid,
        code: z.string(),
        name: z.string(),
        type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
        total_debit: Money,
        total_credit: Money,
        balance: Money.meta({ description: "In the account's normal direction (positive = debit for assets/expenses, credit for the rest)." }),
      }),
    ),
    total_debit: Money,
    total_credit: Money,
  })
  .meta({ id: "TrialBalance" });

export const MeOut = z
  .strictObject({
    organization_id: uuid,
    api_key: z.strictObject({ id: uuid, prefix: z.string(), expires_at: timestampString.nullable() }),
    scopes: z.array(z.string()),
    effective_permissions: z.array(z.string()).meta({ description: "What this key can actually do right now: its scopes intersected with its creator's current role." }),
    rate_limit: z.strictObject({ limit: z.number().int(), remaining: z.number().int(), reset_at: timestampString }),
  })
  .meta({ id: "Me" });

export const ProblemOut = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string(),
    requestId: z.string(),
    errors: z.array(z.strictObject({ field: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: "Problem", description: "RFC 7807 problem details (`application/problem+json`)." });

export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item), next_cursor: z.string().nullable() });
}
export function oneOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: item });
}
