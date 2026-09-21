import type { invoiceStatusEnum, paymentMethodEnum } from "@/db/schema";

export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];

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
