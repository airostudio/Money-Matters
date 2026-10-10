import {
  MAX_CLIENTS_PER_PRACTICE,
  MAX_PENDING_PROPOSALS_PER_ORG,
  MAX_PRACTICES_PER_USER,
  MAX_PRACTICE_STAFF,
  MAX_BULK_SELECTION,
  PRACTICE_ROLE_LABELS,
  type PracticeRole,
} from "./types";

/** Not found OR the caller is not an active member — deliberately indistinguishable. */
export class PracticeNotFoundError extends Error {
  constructor() {
    super("That practice does not exist.");
    this.name = "PracticeNotFoundError";
  }
}

export class PracticePermissionError extends Error {
  constructor(
    public readonly required: PracticeRole,
    public readonly actual: PracticeRole,
    action?: string,
  ) {
    super(
      `${action ?? "That action"} needs the practice role ${PRACTICE_ROLE_LABELS[required]} or higher; you are ${PRACTICE_ROLE_LABELS[actual]}.`,
    );
    this.name = "PracticePermissionError";
  }
}

export class PracticeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeNameError";
  }
}

export class TooManyPracticesError extends Error {
  constructor() {
    super(`You can set up at most ${MAX_PRACTICES_PER_USER} practices.`);
    this.name = "TooManyPracticesError";
  }
}

export class PracticeStaffUserNotFoundError extends Error {
  constructor(email: string) {
    super(`No user with email "${email}" exists yet — they must sign up first.`);
    this.name = "PracticeStaffUserNotFoundError";
  }
}

export class AlreadyPracticeMemberError extends Error {
  constructor() {
    super("That user is already an active member of this practice.");
    this.name = "AlreadyPracticeMemberError";
  }
}

export class PracticeStaffNotFoundError extends Error {
  constructor() {
    super("That person is not a member of this practice.");
    this.name = "PracticeStaffNotFoundError";
  }
}

export class PracticeStaffFullError extends Error {
  constructor() {
    super(`A practice can have at most ${MAX_PRACTICE_STAFF} active staff.`);
    this.name = "PracticeStaffFullError";
  }
}

export class LastPartnerError extends Error {
  constructor() {
    super("A practice must keep at least one partner. Promote another partner first.");
    this.name = "LastPartnerError";
  }
}

export class CannotChangePartnerError extends Error {
  constructor() {
    super(
      "A partner can only step down or leave themselves; another partner cannot demote or remove them. " +
        "Ask them to step down (docs/security.md section 13).",
    );
    this.name = "CannotChangePartnerError";
  }
}

export class InvalidAssigneeError extends Error {
  constructor() {
    super("The assignee must be an active member of this practice.");
    this.name = "InvalidAssigneeError";
  }
}

export class ClientLinkNotFoundError extends Error {
  constructor() {
    super("That client is not linked to this practice.");
    this.name = "ClientLinkNotFoundError";
  }
}

/** Deliberately generic: says nothing about whether the organization exists, is full, or has declined. */
export class ProposalNotPossibleError extends Error {
  constructor() {
    super(
      "That organization could not be found or is not accepting accountant requests right now. " +
        "Check the organization's slug with its owner.",
    );
    this.name = "ProposalNotPossibleError";
  }
}

export class ClientLimitReachedError extends Error {
  constructor() {
    super(`A practice can hold at most ${MAX_CLIENTS_PER_PRACTICE} client links.`);
    this.name = "ClientLimitReachedError";
  }
}

export class LinkAlreadyExistsError extends Error {
  constructor(status: string) {
    super(
      status === "ACTIVE"
        ? "That client is already linked to your practice."
        : "A request to that client is already waiting for the client's owner or administrator to accept it.",
    );
    this.name = "LinkAlreadyExistsError";
  }
}

export class LinkDeclinedError extends Error {
  constructor() {
    super(
      "That client declined the link. Only the client's owner or administrator can re-approve it, from their " +
        "Accountant access settings.",
    );
    this.name = "LinkDeclinedError";
  }
}

export class LinkNotActiveError extends Error {
  constructor() {
    super("This client has not approved (or has withdrawn) your practice's access, so nothing can be read.");
    this.name = "LinkNotActiveError";
  }
}

/**
 * The staff member holds no active membership in the client organization.
 * The message is specific (and includes the seat position when the client is
 * full) because the fix is a human action: the client's administrator adds the
 * person as a member — which uses a seat — or the platform administrator raises
 * the client's seat limit. The seat limit is never bypassed.
 */
export class NotAClientMemberError extends Error {
  constructor(
    public readonly clientName: string,
    public readonly seats: { used: number; limit: number } | null,
    /** The client company is ARCHIVED: one neutral message, no seat or membership detail (nothing about it is disclosed). */
    public readonly unavailable = false,
  ) {
    const full = seats && seats.used >= seats.limit;
    super(
      unavailable
        ? `${clientName} is currently unavailable, so its books cannot be read.`
        : `You are not a member of ${clientName}, so you cannot read its books. Practice access never grants data access by itself: ` +
        `ask ${clientName}'s owner or administrator to add you as a member (Accountant or Bookkeeper)` +
        (full
          ? `. ${clientName} is at its seat limit (${seats.used} of ${seats.limit} seats used), so a seat must be freed first or ` +
            `the platform administrator must raise the limit for that organization — the limit is not bypassed.`
          : seats
            ? `. Adding you uses one of its seats (${seats.used} of ${seats.limit} used).`
            : "."),
    );
    this.name = "NotAClientMemberError";
  }
}

export class BulkSelectionError extends Error {
  constructor(message?: string) {
    super(message ?? `Select between 1 and ${MAX_BULK_SELECTION} clients (one page) for a bulk action.`);
    this.name = "BulkSelectionError";
  }
}

export class TooManyProposalsError extends Error {
  constructor() {
    super(`This organization already holds ${MAX_PENDING_PROPOSALS_PER_ORG} pending requests.`);
    this.name = "TooManyProposalsError";
  }
}

export class PracticeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeValidationError";
  }
}

export class TaskNotFoundError extends Error {
  constructor() {
    super("That task does not exist in this practice.");
    this.name = "TaskNotFoundError";
  }
}
