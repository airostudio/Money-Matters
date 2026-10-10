export class EmployeeNotFoundError extends Error {
  constructor(id: string) {
    super(`Employee ${id} was not found in this organization.`);
    this.name = "EmployeeNotFoundError";
  }
}

export class InvalidEmployeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEmployeeError";
  }
}

export class EmployeeNotActiveError extends Error {
  constructor(name: string) {
    super(`Employee "${name}" is not ACTIVE — this action is not available.`);
    this.name = "EmployeeNotActiveError";
  }
}

export class TaxRuleSetNotFoundError extends Error {
  constructor(jurisdiction: string, payDate: Date) {
    super(
      `No ${jurisdiction} payroll tax rule set covers ${payDate.toISOString().slice(0, 10)}. ` +
        `Only the seeded financial years have rule sets — see docs/roadmap.md's Phase 8 Slice 1 ` +
        `section for exactly which ones, and add a new rule set (never extrapolate one) before ` +
        `running payroll for a date outside them.`,
    );
    this.name = "TaxRuleSetNotFoundError";
  }
}

export class PayRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Pay run ${id} was not found in this organization.`);
    this.name = "PayRunNotFoundError";
  }
}

export class InvalidPayRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPayRunError";
  }
}

export class PayRunNotDraftError extends Error {
  constructor(id: string) {
    super(`Pay run ${id} is not DRAFT — it has already been posted and is immutable.`);
    this.name = "PayRunNotDraftError";
  }
}

export class PayRunNotPostedError extends Error {
  constructor(id: string, status: string) {
    super(`Pay run ${id} is ${status}, not POSTED - this action only applies to a posted pay run.`);
    this.name = "PayRunNotPostedError";
  }
}

export class PayRunHasPaymentsError extends Error {
  constructor(detail: string) {
    super(`This pay run cannot be reversed yet: ${detail}`);
    this.name = "PayRunHasPaymentsError";
  }
}

export class PayrollPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollPaymentError";
  }
}

export class PayslipNotFoundError extends Error {
  constructor() {
    super("That payslip was not found.");
    this.name = "PayslipNotFoundError";
  }
}

export class LeaveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveRequestError";
  }
}

export class DuplicatePayRunPeriodError extends Error {
  constructor(employeeName: string) {
    super(
      `Employee "${employeeName}" already has a pay run line for an overlapping period — ` +
        `correcting a posted pay run requires a reversing entry, never re-running the same period.`,
    );
    this.name = "DuplicatePayRunPeriodError";
  }
}
