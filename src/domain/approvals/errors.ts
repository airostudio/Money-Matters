import type { ApprovalDocumentType } from "./policy";
import { DOCUMENT_TYPE_LABEL } from "./policy";

export class InvalidApprovalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalPolicyError";
  }
}

export class ApprovalPolicyNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval policy ${id} was not found in this organization.`);
    this.name = "ApprovalPolicyNotFoundError";
  }
}

export class ApprovalRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval request ${id} was not found in this organization.`);
    this.name = "ApprovalRequestNotFoundError";
  }
}

/** The document is covered by an approval policy and has not been through it yet. Thrown by the document services, not just the UI. */
export class ApprovalRequiredError extends Error {
  constructor(type: ApprovalDocumentType, label: string) {
    super(`${DOCUMENT_TYPE_LABEL[type]} ${label} needs approval under an approval policy before it can go ahead. Request approval first.`);
    this.name = "ApprovalRequiredError";
  }
}

export class ApprovalPendingError extends Error {
  constructor(type: ApprovalDocumentType, label: string) {
    super(`${DOCUMENT_TYPE_LABEL[type]} ${label} is still waiting for approval under an approval policy.`);
    this.name = "ApprovalPendingError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor() {
    super("This approval request is no longer pending.");
    this.name = "ApprovalNotPendingError";
  }
}

/** The person may not decide this step right now. `reason` is plain English and safe to show. */
export class ApprovalNotEligibleError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ApprovalNotEligibleError";
  }
}

export class ApprovalDocumentNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDocumentNotReadyError";
  }
}

export class NoApprovalPolicyMatchesError extends Error {
  constructor(type: ApprovalDocumentType, label: string) {
    super(`No approval policy applies to ${DOCUMENT_TYPE_LABEL[type].toLowerCase()} ${label}, so it does not need an approval request.`);
    this.name = "NoApprovalPolicyMatchesError";
  }
}
