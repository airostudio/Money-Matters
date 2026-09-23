export class ExpenseClaimNotFoundError extends Error {
  constructor(claimId: string) {
    super(`Expense claim ${claimId} was not found in this organization.`);
    this.name = "ExpenseClaimNotFoundError";
  }
}

export class ExpenseClaimNotEditableError extends Error {
  constructor(claimNumber: string) {
    super(`Expense claim ${claimNumber} is not a draft and cannot be edited or deleted.`);
    this.name = "ExpenseClaimNotEditableError";
  }
}

export class ExpenseClaimNotDraftError extends Error {
  constructor(claimNumber: string) {
    super(`Expense claim ${claimNumber} is not a draft and cannot be submitted.`);
    this.name = "ExpenseClaimNotDraftError";
  }
}

export class ExpenseClaimNotSubmittedError extends Error {
  constructor(claimNumber: string) {
    super(`Expense claim ${claimNumber} has not been submitted and cannot be approved or rejected.`);
    this.name = "ExpenseClaimNotSubmittedError";
  }
}

export class ExpenseClaimNotApprovedError extends Error {
  constructor(claimNumber: string) {
    super(`Expense claim ${claimNumber} is not approved and cannot be marked reimbursed or voided this way.`);
    this.name = "ExpenseClaimNotApprovedError";
  }
}

export class ExpenseClaimAlreadyVoidError extends Error {
  constructor(claimNumber: string) {
    super(`Expense claim ${claimNumber} is already void.`);
    this.name = "ExpenseClaimAlreadyVoidError";
  }
}

export class InvalidExpenseClaimLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExpenseClaimLineError";
  }
}

export class TaxCodeMissingReceivableAccountForExpenseError extends Error {
  constructor(taxCodeCode: string) {
    super(
      `Tax code "${taxCodeCode}" has no receivable (input tax credit) account configured — set one before using it on an expense claim line.`,
    );
    this.name = "TaxCodeMissingReceivableAccountForExpenseError";
  }
}

export class ExpenseClaimForbiddenError extends Error {
  constructor() {
    super("You can only manage your own draft expense claims.");
    this.name = "ExpenseClaimForbiddenError";
  }
}
