import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { ApprovalService, type DecisionOutcome } from "./approval-service";
import type { ApprovalDocumentType } from "./policy";

/**
 * Connects an approval DECISION to the document's own service. The engine (approval-service.ts) only records who decided
 * what; moving the document to its approved/posted state is still done by the document's OWN method, which re-checks
 * its own permission, period locks, creator != approver, and the engine gate. So this layer can never do more than the
 * decider could do by hand, and a failure leaves the request APPROVED with the document untouched (someone holding the
 * document permission can finish it from the document page; the failure is returned, never swallowed).
 */
export interface WorkflowResult {
  outcome: DecisionOutcome;
  requestId: string;
  documentType: ApprovalDocumentType;
  documentId: string;
  /** True when the document itself moved (approved/posted or returned to draft/rejected). */
  documentUpdated: boolean;
  /** Plain-English reason the document did not move although the request was decided. */
  documentError: string | null;
}

async function finalize(actor: Actor, request: { id: string; documentType: string; documentId: string; decisionReason: string | null }, outcome: DecisionOutcome): Promise<{ documentUpdated: boolean; documentError: string | null }> {
  if (outcome !== "APPROVED" && outcome !== "REJECTED") return { documentUpdated: false, documentError: null };
  const type = request.documentType as ApprovalDocumentType;
  try {
    if (outcome === "APPROVED") {
      if (type === "SUPPLIER_BILL") await BillService.approveAndPost(actor, request.documentId);
      else if (type === "EXPENSE_CLAIM") await ExpenseClaimService.approve(actor, request.documentId);
      else await PaymentRunService.approve(actor, request.documentId);
      return { documentUpdated: true, documentError: null };
    }
    const reason = request.decisionReason ?? "Rejected in the approval workflow.";
    if (type === "EXPENSE_CLAIM") {
      await ExpenseClaimService.reject(actor, request.documentId, reason);
      return { documentUpdated: true, documentError: null };
    }
    if (type === "PAYMENT_RUN") {
      await PaymentRunService.returnToDraft(actor, request.documentId, reason);
      return { documentUpdated: true, documentError: null };
    }
    // A draft supplier bill stays a draft; the rejected request (with its reason) is the record, and resubmitting opens a new one.
    return { documentUpdated: false, documentError: null };
  } catch (error) {
    return { documentUpdated: false, documentError: error instanceof Error ? error.message : "The document could not be updated." };
  }
}

export const ApprovalWorkflow = {
  async decide(actor: Actor, requestId: string, input: { decision: "APPROVE" | "REJECT"; comment?: string | null }): Promise<WorkflowResult> {
    const result = await ApprovalService.decide(actor, requestId, input);
    const done = await finalize(actor, result.request, result.outcome);
    return { outcome: result.outcome, requestId, documentType: result.request.documentType as ApprovalDocumentType, documentId: result.request.documentId, ...done };
  },

  async override(actor: Actor, requestId: string, input: { outcome: "APPROVE" | "REJECT"; reason: string }): Promise<WorkflowResult> {
    const result = await ApprovalService.override(actor, requestId, input);
    const done = await finalize(actor, result.request, result.outcome);
    return { outcome: result.outcome, requestId, documentType: result.request.documentType as ApprovalDocumentType, documentId: result.request.documentId, ...done };
  },
};
