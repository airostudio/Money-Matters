import type { ChecklistItem } from "./checklist-types";
import type { LockLevel } from "@/domain/ledger/period-lock";
import { MIN_REASON_LENGTH, TAX_REOPEN_ACK_PHRASE } from "@/domain/ledger/period-lock";

function describe(items: ChecklistItem[]): string {
  return items.map((i) => `${i.title}: ${i.detail}`).join(" | ");
}

/** Closing was refused because BLOCKING items remain. Carries the items. */
export class CloseBlockedError extends Error {
  constructor(public readonly items: ChecklistItem[]) {
    super(`The period cannot be closed: ${items.length} blocking item(s) must be resolved first. ${describe(items)}`);
    this.name = "CloseBlockedError";
  }
}

/** Outstanding (ATTENTION / unsigned manual) items exist and the closer did not explicitly acknowledge them. */
export class CloseAcknowledgementRequiredError extends Error {
  constructor(public readonly items: ChecklistItem[]) {
    super(
      `${items.length} outstanding item(s) must be explicitly acknowledged to close this period anyway: ${describe(items)}`,
    );
    this.name = "CloseAcknowledgementRequiredError";
  }
}

/** The actor cannot see every checklist item (e.g. payroll without `payrun:read`), so cannot knowingly close. */
export class CloseChecklistHiddenError extends Error {
  constructor(public readonly hiddenCount: number) {
    super(
      `${hiddenCount} checklist item(s) are not visible to your role, so you cannot close this period. Ask someone with fuller access to close it.`,
    );
    this.name = "CloseChecklistHiddenError";
  }
}

export class PeriodLockChangeError extends Error {
  constructor(
    public readonly problem:
      | "NO_CHANGE"
      | "REASON_REQUIRED"
      | "TAX_ACKNOWLEDGEMENT_REQUIRED"
      | "NOT_A_RAISE"
      | "NOT_A_LOWER"
      | "INVALID_LEVEL"
      | "ALREADY_CLOSED"
      | "NOT_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "PeriodLockChangeError";
  }

  static reasonRequired(): PeriodLockChangeError {
    return new PeriodLockChangeError(
      "REASON_REQUIRED",
      `A reason of at least ${MIN_REASON_LENGTH} characters is required to reopen or lower the lock on a period.`,
    );
  }

  static taxAcknowledgementRequired(): PeriodLockChangeError {
    return new PeriodLockChangeError(
      "TAX_ACKNOWLEDGEMENT_REQUIRED",
      `Reopening a tax-locked period requires acknowledging that doing so ${TAX_REOPEN_ACK_PHRASE}. Type that acknowledgement to proceed.`,
    );
  }

  static noChange(level: LockLevel): PeriodLockChangeError {
    return new PeriodLockChangeError("NO_CHANGE", `The period is already ${level}.`);
  }
}

export class SignoffError extends Error {
  constructor(
    public readonly problem: "UNKNOWN_CHECK" | "ALREADY_SIGNED_OFF" | "NOT_SIGNED_OFF" | "PERIOD_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "SignoffError";
  }
}
