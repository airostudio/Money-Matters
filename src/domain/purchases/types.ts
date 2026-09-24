import type {
  billStatusEnum,
  paymentMethodEnum,
  paymentRunStatusEnum,
  purchaseOrderStatusEnum,
  recurringFrequencyEnum,
  supplierCreditStatusEnum,
} from "@/db/schema";

export type BillStatus = (typeof billStatusEnum.enumValues)[number];
export type SupplierPaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type PurchaseOrderStatus = (typeof purchaseOrderStatusEnum.enumValues)[number];
export type SupplierCreditStatus = (typeof supplierCreditStatusEnum.enumValues)[number];
export type PaymentRunStatus = (typeof paymentRunStatusEnum.enumValues)[number];
export type RecurringFrequency = (typeof recurringFrequencyEnum.enumValues)[number];

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
  /** Optional link to an uploaded receipt/invoice (Document AI capture) this line was prefilled from — informational only. */
  receiptId?: string;
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
  /** Set when this bill was created via `PurchaseOrderService.convertToBill` — never set directly by a caller creating a normal bill. */
  purchaseOrderId?: string;
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

// ---------------------------------------------------------------------------
// Purchase orders + three-way matching (Phase 4 Slice 2)
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineInput {
  description: string;
  /** Decimal string, e.g. "2.00". Must be positive. */
  quantity: string;
  /** Decimal string, e.g. "150.00". May be zero, never negative. */
  unitPrice: string;
  accountId: string;
  taxCodeId?: string;
}

export interface CreatePurchaseOrderInput {
  supplierContactId: string;
  issueDate: Date;
  expectedDate?: Date;
  currency: string;
  memo?: string;
  lines: PurchaseOrderLineInput[];
}

export type UpdatePurchaseOrderInput = CreatePurchaseOrderInput;

export interface RecordPurchaseOrderReceiptLineInput {
  purchaseOrderLineId: string;
  /** Decimal string. Must be positive and not push this line's total received past its ordered quantity. */
  quantityReceived: string;
}

export interface RecordPurchaseOrderReceiptInput {
  receivedDate: Date;
  memo?: string;
  lines: RecordPurchaseOrderReceiptLineInput[];
}

/** One discrepancy the three-way match found between a PO line, what's been received against it, and what the supplier's bill line claims. */
export interface ThreeWayMatchDiscrepancy {
  poLineId: string;
  description: string;
  orderedQuantity: string;
  receivedQuantity: string;
  billedQuantity: string;
  orderedUnitPrice: string;
  billedUnitPrice: string;
  kind: "QUANTITY_EXCEEDS_RECEIVED" | "QUANTITY_EXCEEDS_ORDERED" | "PRICE_MISMATCH";
  message: string;
}

export interface ThreeWayMatchResult {
  matched: boolean;
  discrepancies: ThreeWayMatchDiscrepancy[];
}

/** The bill lines a human has confirmed for `PurchaseOrderService.convertToBill`, matched 1:1 to the PO's own lines by `poLineId`. Quantity/price may differ from the PO (that's exactly what the three-way match flags) — this is what actually gets billed. */
export interface ConvertPurchaseOrderLineInput {
  poLineId: string;
  quantity: string;
  unitPrice: string;
}

export interface ConvertPurchaseOrderToBillInput {
  issueDate: Date;
  dueDate: Date;
  apAccountId: string;
  supplierReference?: string;
  memo?: string;
  lines: ConvertPurchaseOrderLineInput[];
  /** Must be explicitly true to proceed when the three-way match found any discrepancy — the "confirm anyway" step; never a silent default. */
  acknowledgeDiscrepancies?: boolean;
}

// ---------------------------------------------------------------------------
// Recurring bills (Phase 4 Slice 2)
// ---------------------------------------------------------------------------

export interface RecurringBillTemplateLineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId?: string;
}

export interface CreateRecurringBillTemplateInput {
  supplierContactId: string;
  name: string;
  currency: string;
  apAccountId: string;
  memo?: string;
  frequency: RecurringFrequency;
  startDate: Date;
  endDate?: Date;
  maxOccurrences?: number;
  lines: RecurringBillTemplateLineInput[];
}

export type UpdateRecurringBillTemplateInput = CreateRecurringBillTemplateInput;

// ---------------------------------------------------------------------------
// Supplier credits (Phase 4 Slice 2)
// ---------------------------------------------------------------------------

export type SupplierCreditLineInput = BillLineInput;

export interface CreateSupplierCreditInput {
  supplierContactId: string;
  issueDate: Date;
  currency: string;
  /** The Accounts Payable control account this credit note posts to — normally the same account the original bill used. */
  apAccountId: string;
  memo?: string;
  lines: SupplierCreditLineInput[];
}

export type UpdateSupplierCreditInput = CreateSupplierCreditInput;

// ---------------------------------------------------------------------------
// Payment runs with segregation of duties (Phase 4 Slice 2)
// ---------------------------------------------------------------------------

export interface CreatePaymentRunInput {
  paymentDate: Date;
  currency: string;
  /** The ASSET account credited for every payment this run generates. */
  paymentAccountId: string;
  memo?: string;
  /** Bills to include, each with the amount to pay (defaults to full outstanding if omitted). Every bill must be APPROVED/PART_PAID and in this currency. */
  billIds: string[];
}
