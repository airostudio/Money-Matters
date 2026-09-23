import type { billStatusEnum, paymentMethodEnum } from "@/db/schema";

export type BillStatus = (typeof billStatusEnum.enumValues)[number];
export type SupplierPaymentMethod = (typeof paymentMethodEnum.enumValues)[number];

export interface BillLineInput {
  description: string;
  /** Decimal string, e.g. "2.00". Must be positive. */
  quantity: string;
  /** Decimal string, e.g. "150.00". May be zero, never negative. */
  unitPrice: string;
  /** Expense/asset account this line's amount is debited to on posting. */
  accountId: string;
  /** Optional — a zero-rated/out-of-scope line has none. */
  taxCodeId?: string;
}

export interface CreateBillInput {
  supplierContactId: string;
  issueDate: Date;
  dueDate: Date;
  currency: string;
  /** The Accounts Payable control account this bill posts to. */
  apAccountId: string;
  memo?: string;
  /** The supplier's own invoice number — informational only, never used for uniqueness. */
  supplierReference?: string;
  lines: BillLineInput[];
}

export type UpdateBillInput = CreateBillInput;

export interface RecordSupplierPaymentAllocationInput {
  billId: string;
  /** Decimal string. Must not exceed the bill's outstanding balance. */
  amount: string;
}

export interface RecordSupplierPaymentInput {
  supplierContactId: string;
  paymentDate: Date;
  /** Decimal string. Must be at least the sum of `allocations[].amount`. */
  amount: string;
  currency: string;
  method: SupplierPaymentMethod;
  /** The ASSET account credited on posting (a bank account's own GL account). */
  paymentAccountId: string;
  /** Optional informational link to Phase 2's bank_accounts, for later bank-feed reconciliation. */
  bankAccountId?: string;
  reference?: string;
  allocations: RecordSupplierPaymentAllocationInput[];
}
