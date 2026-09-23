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
