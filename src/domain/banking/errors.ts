export class BankAccountNotFoundError extends Error {
  constructor(bankAccountId: string) {
    super(`Bank account ${bankAccountId} was not found in this organization.`);
    this.name = "BankAccountNotFoundError";
  }
}

export class DuplicateBankAccountError extends Error {
  constructor() {
    super("That ledger account is already linked to another bank account.");
    this.name = "DuplicateBankAccountError";
  }
}

export class BankTransactionNotFoundError extends Error {
  constructor(bankTransactionId: string) {
    super(`Bank transaction ${bankTransactionId} was not found in this organization.`);
    this.name = "BankTransactionNotFoundError";
  }
}

export class BankTransactionAlreadyMatchedError extends Error {
  constructor(bankTransactionId: string) {
    super(`Bank transaction ${bankTransactionId} has already been reconciled.`);
    this.name = "BankTransactionAlreadyMatchedError";
  }
}

export class StatementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementParseError";
  }
}

export class BankRuleNotFoundError extends Error {
  constructor(bankRuleId: string) {
    super(`Bank rule ${bankRuleId} was not found in this organization.`);
    this.name = "BankRuleNotFoundError";
  }
}
