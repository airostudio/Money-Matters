export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} was not found in this organization.`);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvoiceNotEditableError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "InvoiceNotEditableError";
  }
}

export class InvoiceNotDraftError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} is not a draft and cannot be posted.`);
    this.name = "InvoiceNotDraftError";
  }
}

export class InvoiceAlreadyVoidError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} is already void.`);
    this.name = "InvoiceAlreadyVoidError";
  }
}

export class InvoiceNotPostedError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} has not been posted and cannot be voided this way — delete the draft instead.`);
    this.name = "InvoiceNotPostedError";
  }
}

export class InvoiceHasPaymentsError extends Error {
  constructor(invoiceNumber: string) {
    super(
      `Invoice ${invoiceNumber} has payments allocated against it — unallocate them before voiding.`,
    );
    this.name = "InvoiceHasPaymentsError";
  }
}

export class InvalidInvoiceLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvoiceLineError";
  }
}

export class TaxCodeMissingPayableAccountError extends Error {
  constructor(taxCodeCode: string) {
    super(
      `Tax code "${taxCodeCode}" has no payable (liability) account configured — set one before using it on an invoice.`,
    );
    this.name = "TaxCodeMissingPayableAccountError";
  }
}

export class InvalidContactForInvoiceError extends Error {
  constructor(contactId: string) {
    super(`Contact ${contactId} is not an active customer.`);
    this.name = "InvalidContactForInvoiceError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} was not found in this organization.`);
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentOverAllocatedError extends Error {
  constructor() {
    super("The sum of the allocations exceeds the payment's own amount.");
    this.name = "PaymentOverAllocatedError";
  }
}

export class AllocationExceedsOutstandingError extends Error {
  constructor(invoiceNumber: string, outstanding: string, requested: string) {
    super(
      `Cannot allocate ${requested} to invoice ${invoiceNumber} — only ${outstanding} is outstanding on it.`,
    );
    this.name = "AllocationExceedsOutstandingError";
  }
}

export class InvoiceCurrencyMismatchError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} is in a different currency than this payment.`);
    this.name = "InvoiceCurrencyMismatchError";
  }
}

export class InvoiceNotPostedForPaymentError extends Error {
  constructor(invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} has not been posted yet and cannot receive a payment.`);
    this.name = "InvoiceNotPostedForPaymentError";
  }
}
