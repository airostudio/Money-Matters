import { LOCK_LABELS, MIN_REASON_LENGTH, whoCanReopen, type LockLevel, type PostingDenialCode } from "./period-lock";

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

/**
 * A posting was rejected because its period is locked. Backward compatible
 * (still `new PeriodLockedError(label)` and still named "PeriodLockedError"),
 * but now carries the lock level and a plain-language explanation of the
 * consequence and who can reopen it (master spec §79 — never a dead-end
 * "locked" message). `canOverrideWithReason` is true when the actor could
 * post inline by supplying a reason (SOFT_LOCKED + `period:override_soft`) —
 * the UI uses it to offer "Post anyway — reason required".
 */
export class PeriodLockedError extends Error {
  readonly lockLevel: LockLevel | null;
  readonly denialCode: PostingDenialCode | null;
  readonly canOverrideWithReason: boolean;
  readonly periodLabel: string;

  constructor(
    periodLabel: string,
    detail: { lockLevel?: LockLevel; denialCode?: PostingDenialCode; canOverrideWithReason?: boolean } = {},
  ) {
    const level = detail.lockLevel ?? null;
    const explanation = level ? ` ${explainLock(level, detail.denialCode ?? null)}` : "";
    super(`Fiscal period "${periodLabel}" is locked; postings are not accepted.${explanation}`);
    this.name = "PeriodLockedError";
    this.periodLabel = periodLabel;
    this.lockLevel = level;
    this.denialCode = detail.denialCode ?? null;
    this.canOverrideWithReason = detail.canOverrideWithReason ?? false;
  }
}

function explainLock(level: LockLevel, code: PostingDenialCode | null): string {
  const who = whoCanReopen(level);
  switch (code) {
    case "OVERRIDE_REASON_REQUIRED":
      return `It is soft-locked: you may post anyway, but a reason (at least ${MIN_REASON_LENGTH} characters) is required and will be recorded.`;
    case "SOFT_LOCKED_NOT_AUTHORISED":
      return `It is soft-locked and your role cannot override a soft lock. ${who} (or post in an open period instead).`;
    case "ADVISOR_LOCKED_NOT_AUTHORISED":
      return `It is advisor-locked while the accountant finalises adjustments; only accountant-level roles can post. ${who}.`;
    case "TAX_LOCKED":
      return `It is tax-locked (covered by a lodged return), so no one can post — a change could invalidate the lodgement. ${who}, with a reason and an acknowledgement. Posted entries are never altered; correct later by posting an adjustment in an open period.`;
    case "HARD_LOCKED":
    default:
      return `It is ${LOCK_LABELS[level].toLowerCase()}ed, so no one can post. ${who}, with a reason. Posted entries are never altered; correct later by posting an adjustment in an open period.`;
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

export class FiscalPeriodNotFoundError extends Error {
  constructor(periodId: string) {
    super(`Fiscal period ${periodId} was not found in this organization.`);
    this.name = "FiscalPeriodNotFoundError";
  }
}
