export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found in this organization.`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectCodeInUseError extends Error {
  constructor(code: string) {
    super(`Project code "${code}" is already in use in this organization.`);
    this.name = "ProjectCodeInUseError";
  }
}

export class ProjectNotActiveError extends Error {
  constructor(code: string) {
    super(`Project ${code} is not active — reactivate it before logging time or cost against it.`);
    this.name = "ProjectNotActiveError";
  }
}

export class ProjectAlreadyClosedError extends Error {
  constructor(code: string) {
    super(`Project ${code} is already closed.`);
    this.name = "ProjectAlreadyClosedError";
  }
}

export class ProjectTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Project task ${taskId} was not found in this organization.`);
    this.name = "ProjectTaskNotFoundError";
  }
}

export class ProjectTaskBelongsToAnotherProjectError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} does not belong to this project.`);
    this.name = "ProjectTaskBelongsToAnotherProjectError";
  }
}

export class InvalidContactForProjectError extends Error {
  constructor(contactId: string) {
    super(`Contact ${contactId} is not an active customer.`);
    this.name = "InvalidContactForProjectError";
  }
}

export class TimesheetEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Timesheet entry ${entryId} was not found in this organization.`);
    this.name = "TimesheetEntryNotFoundError";
  }
}

export class TimesheetEntryForbiddenError extends Error {
  constructor() {
    super("You may only view or edit your own timesheet entries unless you are an approver.");
    this.name = "TimesheetEntryForbiddenError";
  }
}

export class TimesheetEntryNotEditableError extends Error {
  constructor(entryId: string) {
    super(`Timesheet entry ${entryId} is not editable in its current status.`);
    this.name = "TimesheetEntryNotEditableError";
  }
}

export class TimesheetEntryNotDraftError extends Error {
  constructor(entryId: string) {
    super(`Timesheet entry ${entryId} is not a draft and cannot be submitted.`);
    this.name = "TimesheetEntryNotDraftError";
  }
}

export class TimesheetEntryNotSubmittedError extends Error {
  constructor(entryId: string) {
    super(`Timesheet entry ${entryId} has not been submitted and cannot be approved or rejected.`);
    this.name = "TimesheetEntryNotSubmittedError";
  }
}

export class TimerAlreadyRunningError extends Error {
  constructor() {
    super("You already have a running timer — stop it before starting another.");
    this.name = "TimerAlreadyRunningError";
  }
}

export class NoRunningTimerError extends Error {
  constructor() {
    super("You have no running timer to stop.");
    this.name = "NoRunningTimerError";
  }
}

export class InvalidTimesheetEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimesheetEntryError";
  }
}

export class NoBillingRateError extends Error {
  constructor(label: string) {
    super(`${label} has no billing rate set — add a default hourly rate (or a task override) before invoicing time.`);
    this.name = "NoBillingRateError";
  }
}

export class NoUnbilledTimeError extends Error {
  constructor() {
    super("No approved, billable, un-invoiced time was found for this project in the given range.");
    this.name = "NoUnbilledTimeError";
  }
}

export class ProjectHasNoCustomerError extends Error {
  constructor(code: string) {
    super(`Project ${code} has no customer — attach one before invoicing time against it.`);
    this.name = "ProjectHasNoCustomerError";
  }
}
