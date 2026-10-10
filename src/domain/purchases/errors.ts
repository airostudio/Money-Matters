export class BillNotFoundError extends Error {
  constructor(billId: string) {
    super(`Bill ${billId} was not found in this organization.`);
    this.name = "BillNotFoundError";
  }
}

export class BillNotEditableError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "BillNotEditableError";
  }
}

export class BillNotDraftError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is not a draft and cannot be posted.`);
    this.name = "BillNotDraftError";
  }
}

export class BillAlreadyVoidError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is already void.`);
    this.name = "BillAlreadyVoidError";
  }
}

export class BillNotPostedError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} has not been posted and cannot be voided this way — delete the draft instead.`);
    this.name = "BillNotPostedError";
  }
}

export class BillHasPaymentsError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} has payments allocated against it — unallocate them before voiding.`);
    this.name = "BillHasPaymentsError";
  }
}

export class InvalidBillLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBillLineError";
  }
}

export class TaxCodeMissingReceivableAccountError extends Error {
  constructor(taxCodeCode: string) {
    super(
      `Tax code "${taxCodeCode}" has no receivable (input tax credit) account configured — set one before using it on a bill.`,
    );
    this.name = "TaxCodeMissingReceivableAccountError";
  }
}

export class InvalidContactForBillError extends Error {
  constructor(contactId: string) {
    super(`Contact ${contactId} is not an active supplier.`);
    this.name = "InvalidContactForBillError";
  }
}

export class SupplierPaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Supplier payment ${paymentId} was not found in this organization.`);
    this.name = "SupplierPaymentNotFoundError";
  }
}

export class SupplierPaymentOverAllocatedError extends Error {
  constructor() {
    super("The sum of the allocations exceeds the payment's own amount.");
    this.name = "SupplierPaymentOverAllocatedError";
  }
}

export class SupplierAllocationExceedsOutstandingError extends Error {
  constructor(billNumber: string, outstanding: string, requested: string) {
    super(`Cannot allocate ${requested} to bill ${billNumber} — only ${outstanding} is outstanding on it.`);
    this.name = "SupplierAllocationExceedsOutstandingError";
  }
}

export class BillCurrencyMismatchError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is in a different currency than this payment.`);
    this.name = "BillCurrencyMismatchError";
  }
}

export class BillNotPostedForPaymentError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} has not been posted yet and cannot receive a payment.`);
    this.name = "BillNotPostedForPaymentError";
  }
}

// ---------------------------------------------------------------------------
// Purchase orders + three-way matching
// ---------------------------------------------------------------------------

export class PurchaseOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Purchase order ${id} was not found in this organization.`);
    this.name = "PurchaseOrderNotFoundError";
  }
}

export class PurchaseOrderNotEditableError extends Error {
  constructor(poNumber: string) {
    super(`Purchase order ${poNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "PurchaseOrderNotEditableError";
  }
}

export class PurchaseOrderNotReceivableError extends Error {
  constructor(poNumber: string) {
    super(`Purchase order ${poNumber} is not in a state that can receive goods (draft or cancelled).`);
    this.name = "PurchaseOrderNotReceivableError";
  }
}

export class PurchaseOrderAlreadyConvertedError extends Error {
  constructor(poNumber: string) {
    super(`Purchase order ${poNumber} has already been fully converted to a bill.`);
    this.name = "PurchaseOrderAlreadyConvertedError";
  }
}

export class PurchaseOrderNotConvertibleError extends Error {
  constructor(poNumber: string) {
    super(`Purchase order ${poNumber} has nothing received yet and cannot be converted to a bill.`);
    this.name = "PurchaseOrderNotConvertibleError";
  }
}

export class InvalidPurchaseOrderLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPurchaseOrderLineError";
  }
}

export class ReceiptExceedsOrderedQuantityError extends Error {
  constructor(lineDescription: string, ordered: string, alreadyReceived: string, requested: string) {
    super(
      `Cannot receive ${requested} of "${lineDescription}" — only ${ordered} was ordered and ${alreadyReceived} already received.`,
    );
    this.name = "ReceiptExceedsOrderedQuantityError";
  }
}

export class UnacknowledgedMatchDiscrepancyError extends Error {
  constructor() {
    super("The three-way match found discrepancies between the PO, what was received, and this bill — confirm to proceed anyway.");
    this.name = "UnacknowledgedMatchDiscrepancyError";
  }
}

// ---------------------------------------------------------------------------
// Recurring bills
// ---------------------------------------------------------------------------

export class RecurringBillTemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Recurring bill template ${id} was not found in this organization.`);
    this.name = "RecurringBillTemplateNotFoundError";
  }
}

export class InvalidRecurringBillTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecurringBillTemplateError";
  }
}

// ---------------------------------------------------------------------------
// Supplier credits
// ---------------------------------------------------------------------------

export class SupplierCreditNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier credit note ${id} was not found in this organization.`);
    this.name = "SupplierCreditNotFoundError";
  }
}

export class SupplierCreditNotEditableError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "SupplierCreditNotEditableError";
  }
}

export class SupplierCreditNotDraftError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is not a draft and cannot be posted.`);
    this.name = "SupplierCreditNotDraftError";
  }
}

export class SupplierCreditNotPostedError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} has not been posted yet.`);
    this.name = "SupplierCreditNotPostedError";
  }
}

export class SupplierCreditAlreadyVoidError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is already void.`);
    this.name = "SupplierCreditAlreadyVoidError";
  }
}

export class SupplierCreditHasAllocationsError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} has been applied to bills — unallocate it before voiding.`);
    this.name = "SupplierCreditHasAllocationsError";
  }
}

export class SupplierCreditAllocationExceedsAvailableError extends Error {
  constructor(creditNoteNumber: string, available: string, requested: string) {
    super(`Cannot apply ${requested} of credit note ${creditNoteNumber} — only ${available} remains available on it.`);
    this.name = "SupplierCreditAllocationExceedsAvailableError";
  }
}

export class SupplierCreditCurrencyMismatchError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is in a different currency than the bill it's being applied to.`);
    this.name = "SupplierCreditCurrencyMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Payment runs with segregation of duties
// ---------------------------------------------------------------------------

export class PaymentRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment run ${id} was not found in this organization.`);
    this.name = "PaymentRunNotFoundError";
  }
}

export class PaymentRunNotEditableError extends Error {
  constructor(runNumber: string) {
    super(`Payment run ${runNumber} is not a draft and cannot be edited.`);
    this.name = "PaymentRunNotEditableError";
  }
}

export class PaymentRunNotAwaitingApprovalError extends Error {
  constructor(runNumber: string) {
    super(`Payment run ${runNumber} is not awaiting approval.`);
    this.name = "PaymentRunNotAwaitingApprovalError";
  }
}

export class PaymentRunEmptyError extends Error {
  constructor() {
    super("A payment run needs at least one bill before it can be submitted.");
    this.name = "PaymentRunEmptyError";
  }
}

/**
 * The segregation-of-duties enforcement per master spec §52: the user who
 * created/prepared a payment run must not be the same user who approves it.
 * Thrown by `PaymentRunService.approve` in the service layer itself — never
 * just a UI hint — unless the organization has only one member eligible to
 * approve at all, in which case `PaymentRunService` documents and allows the
 * self-approval rather than permanently locking a one-person/two-person
 * organization out of ever paying anything (see docs/roadmap.md).
 */
export class SelfApprovalNotAllowedError extends Error {
  constructor(runNumber: string) {
    super(`Payment run ${runNumber} was created by this user — a different user must approve it.`);
    this.name = "SelfApprovalNotAllowedError";
  }
}

export class BillNotEligibleForPaymentRunError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is not APPROVED/PART_PAID or is fully paid, and cannot be added to a payment run.`);
    this.name = "BillNotEligibleForPaymentRunError";
  }
}

export class PaymentRunCurrencyMismatchError extends Error {
  constructor(billNumber: string) {
    super(`Bill ${billNumber} is in a different currency than this payment run.`);
    this.name = "PaymentRunCurrencyMismatchError";
  }
}
