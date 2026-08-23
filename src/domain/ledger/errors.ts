export class UnbalancedJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbalancedJournalError";
  }
}

export class InvalidJournalLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJournalLineError";
  }
}

export class PeriodLockedError extends Error {
  constructor(periodLabel: string) {
    super(`Fiscal period "${periodLabel}" is locked; postings are not accepted.`);
    this.name = "PeriodLockedError";
  }
}

export class ImmutableEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableEntryError";
  }
}

export class EntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Journal entry ${entryId} was not found in this organization.`);
    this.name = "EntryNotFoundError";
  }
}
