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

export class QuoteNotFoundError extends Error {
  constructor(quoteId: string) {
    super(`Quote ${quoteId} was not found in this organization.`);
    this.name = "QuoteNotFoundError";
  }
}

export class QuoteNotEditableError extends Error {
  constructor(quoteNumber: string) {
    super(`Quote ${quoteNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "QuoteNotEditableError";
  }
}

export class QuoteNotSentError extends Error {
  constructor(quoteNumber: string) {
    super(`Quote ${quoteNumber} has not been sent and cannot be accepted or declined yet.`);
    this.name = "QuoteNotSentError";
  }
}

export class QuoteNotAcceptedError extends Error {
  constructor(quoteNumber: string) {
    super(`Quote ${quoteNumber} has not been accepted and cannot be converted to an invoice.`);
    this.name = "QuoteNotAcceptedError";
  }
}

export class QuoteAlreadyConvertedError extends Error {
  constructor(quoteNumber: string) {
    super(`Quote ${quoteNumber} has already been converted to an invoice.`);
    this.name = "QuoteAlreadyConvertedError";
  }
}

export class RecurringTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Recurring invoice template ${templateId} was not found in this organization.`);
    this.name = "RecurringTemplateNotFoundError";
  }
}

export class InvalidRecurringTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecurringTemplateError";
  }
}

// ---------------------------------------------------------------------------
// Sales documents slice: customer credit notes, unapplied credit, receipts
// ---------------------------------------------------------------------------

export class CustomerCreditNotFoundError extends Error {
  constructor(creditId: string) {
    super(`Customer credit note ${creditId} was not found in this organization.`);
    this.name = "CustomerCreditNotFoundError";
  }
}

export class CustomerCreditNotEditableError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "CustomerCreditNotEditableError";
  }
}

export class CustomerCreditNotDraftError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is not a draft and cannot be posted.`);
    this.name = "CustomerCreditNotDraftError";
  }
}

export class CustomerCreditNotPostedError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} has not been posted (or is void), so it cannot be applied or voided this way.`);
    this.name = "CustomerCreditNotPostedError";
  }
}

export class CustomerCreditAlreadyVoidError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is already void.`);
    this.name = "CustomerCreditAlreadyVoidError";
  }
}

export class CustomerCreditHasAllocationsError extends Error {
  constructor(creditNoteNumber: string) {
    super(`Credit note ${creditNoteNumber} is applied to one or more invoices - un-apply it before voiding.`);
    this.name = "CustomerCreditHasAllocationsError";
  }
}

export class CustomerCreditAllocationExceedsAvailableError extends Error {
  constructor(source: string, available: string, requested: string) {
    super(`Cannot apply ${requested} from ${source} - only ${available} of it is still unapplied.`);
    this.name = "CustomerCreditAllocationExceedsAvailableError";
  }
}

export class CustomerCreditCurrencyMismatchError extends Error {
  constructor(source: string, invoiceNumber: string) {
    super(`${source} and invoice ${invoiceNumber} are in different currencies.`);
    this.name = "CustomerCreditCurrencyMismatchError";
  }
}

export class CustomerCreditCustomerMismatchError extends Error {
  constructor(source: string, invoiceNumber: string) {
    super(`${source} and invoice ${invoiceNumber} belong to different customers - credit can only be applied within one customer.`);
    this.name = "CustomerCreditCustomerMismatchError";
  }
}

export class CustomerCreditExceedsInvoiceError extends Error {
  constructor(creditNoteNumber: string, invoiceNumber: string, remaining: string) {
    super(
      `Credit note ${creditNoteNumber} would credit invoice ${invoiceNumber} by more than the invoice total - only ${remaining} of the invoice can still be credited.`,
    );
    this.name = "CustomerCreditExceedsInvoiceError";
  }
}

export class CustomerCreditTrackedStockError extends Error {
  constructor(sku: string) {
    super(
      `Product ${sku} is stock-tracked. Customer credit notes do not reverse stock or cost of goods sold, so a tracked-stock product cannot be credited here - credit the revenue account directly (a price adjustment) and record any returned stock with an inventory adjustment.`,
    );
    this.name = "CustomerCreditTrackedStockError";
  }
}

export class CustomerCreditAllocationNotFoundError extends Error {
  constructor(allocationId: string) {
    super(`Credit allocation ${allocationId} was not found in this organization.`);
    this.name = "CustomerCreditAllocationNotFoundError";
  }
}

export class CustomerCreditAllocationAlreadyReversedError extends Error {
  constructor() {
    super("That credit allocation has already been reversed (or is itself a reversal).");
    this.name = "CustomerCreditAllocationAlreadyReversedError";
  }
}

export class PaymentNotUnappliedError extends Error {
  constructor(available: string, requested: string) {
    super(`Cannot apply ${requested} from this payment - only ${available} of it is unapplied.`);
    this.name = "PaymentNotUnappliedError";
  }
}

export class PaymentNeedsReceivableAccountError extends Error {
  constructor() {
    super(
      "A payment that is not fully allocated to invoices needs a receivable account for the unallocated part - choose one.",
    );
    this.name = "PaymentNeedsReceivableAccountError";
  }
}

export class ReceiptNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`No receipt exists for payment ${paymentId} in this organization.`);
    this.name = "ReceiptNotFoundError";
  }
}

export class StatementRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementRangeError";
  }
}
