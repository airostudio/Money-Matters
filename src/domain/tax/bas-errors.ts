export class BasNotFoundError extends Error {
  constructor(id: string) {
    super(`BAS statement ${id} was not found in this organization.`);
    this.name = "BasNotFoundError";
  }
}

export class BasInvalidPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BasInvalidPeriodError";
  }
}

export class BasBasisNotSupportedError extends Error {
  constructor(basis: string) {
    super(
      `BAS basis "${basis}" is not supported: only ACCRUAL (invoice/bill basis) is implemented. Cash-basis GST needs payment-level GST allocation, which is not built; Money Matters refuses rather than approximate it.`,
    );
    this.name = "BasBasisNotSupportedError";
  }
}

export class BasNotDraftError extends Error {
  constructor(id: string) {
    super(`BAS statement ${id} is not a DRAFT - a finalised BAS is an immutable snapshot. Prepare a new statement for a revision.`);
    this.name = "BasNotDraftError";
  }
}

export class BasNotFinalisedError extends Error {
  constructor(id: string) {
    super(`BAS statement ${id} must be FINALISED before a lodgement made outside Money Matters can be recorded.`);
    this.name = "BasNotFinalisedError";
  }
}

export class BasWarningsNotAcknowledgedError extends Error {
  constructor(public readonly warnings: string[]) {
    super(
      `This BAS has ${warnings.length} outstanding warning(s) that must be explicitly acknowledged before finalising: ${warnings.join(" | ")}`,
    );
    this.name = "BasWarningsNotAcknowledgedError";
  }
}
