import type {
  invoiceStatusEnum,
  paymentMethodEnum,
  quoteStatusEnum,
  recurringFrequencyEnum,
} from "@/db/schema";

export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type QuoteStatus = (typeof quoteStatusEnum.enumValues)[number];
export type RecurringFrequency = (typeof recurringFrequencyEnum.enumValues)[number];

export interface InvoiceLineInput {
  description: string;
  /** Decimal string, e.g. "2.00". Must be positive. */
  quantity: string;
  /** Decimal string, e.g. "150.00". May be zero, never negative. */
  unitPrice: string;
  /** Revenue account this line's amount is credited to on posting. */
  accountId: string;
  /** Optional — a zero-rated/out-of-scope line has none. */
  taxCodeId?: string;
}

export interface CreateInvoiceInput {
  customerContactId: string;
  issueDate: Date;
  dueDate: Date;
  currency: string;
  /** The Accounts Receivable control account this invoice posts to. */
  arAccountId: string;
  memo?: string;
  lines: InvoiceLineInput[];
}

export type UpdateInvoiceInput = CreateInvoiceInput;

export interface RecordPaymentAllocationInput {
  invoiceId: string;
  /** Decimal string. Must not exceed the invoice's outstanding balance. */
  amount: string;
}

/**
 * A quote's line is shaped identically to an invoice's — same
 * quantity/unitPrice/accountId/taxCodeId fields — so `calculateInvoiceTotals`
 * can be reused verbatim for quote totals, and a quote's lines can be copied
 * onto a new invoice's lines without any field-by-field translation.
 */
export type QuoteLineInput = InvoiceLineInput;

export interface CreateQuoteInput {
  customerContactId: string;
  issueDate: Date;
  expiryDate: Date;
  currency: string;
  memo?: string;
  lines: QuoteLineInput[];
}

export type UpdateQuoteInput = CreateQuoteInput;

export interface RecurringInvoiceTemplateLineInput {
  description: string;
  /** Decimal string, e.g. "2.00". Must be positive. */
  quantity: string;
  /** Decimal string, e.g. "150.00". May be zero, never negative. */
  unitPrice: string;
  /** Revenue account this line's amount is credited to when an invoice is generated. */
  accountId: string;
  taxCodeId?: string;
}

export interface CreateRecurringInvoiceTemplateInput {
  customerContactId: string;
  name: string;
  currency: string;
  arAccountId: string;
  memo?: string;
  frequency: RecurringFrequency;
  startDate: Date;
  /** Optional — no end date means "run until maxOccurrences or paused". */
  endDate?: Date;
  /** Optional — no cap means "run until endDate or paused". */
  maxOccurrences?: number;
  lines: RecurringInvoiceTemplateLineInput[];
}

export type UpdateRecurringInvoiceTemplateInput = CreateRecurringInvoiceTemplateInput;

export interface RecordPaymentInput {
  customerContactId: string;
  paymentDate: Date;
  /** Decimal string. Must be at least the sum of `allocations[].amount`. */
  amount: string;
  currency: string;
  method: PaymentMethod;
  /** The ASSET account debited on posting (a bank account's own GL account, or an Undeposited Funds clearing account). */
  depositAccountId: string;
  /** Optional informational link to Phase 2's bank_accounts, for later bank-feed reconciliation. */
  bankAccountId?: string;
  reference?: string;
  allocations: RecordPaymentAllocationInput[];
}
