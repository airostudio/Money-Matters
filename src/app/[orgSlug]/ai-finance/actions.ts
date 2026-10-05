"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { FinancialControllerService, type ConversationTurn } from "@/domain/ai-controller/financial-controller-service";
import { AGENT_MODE_IDS, type AgentMode } from "@/domain/ai-controller/specialist-agents";
import { AIDraftProposalService, type DraftProposalPreview } from "@/domain/ai-controller/draft-proposal-service";

const TurnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
const AskSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z.array(TurnSchema).max(40),
  agentMode: z.enum(AGENT_MODE_IDS as [AgentMode, ...AgentMode[]]).optional(),
});

export interface PendingProposal {
  id: string;
  preview: DraftProposalPreview;
}

export interface AskControllerResult {
  status: "ok" | "unavailable";
  answer?: string;
  reason?: string;
  proposals?: PendingProposal[];
}

/**
 * The AI Financial Controller's server action — called directly from the
 * client chat component (`controller-chat.tsx`) via a React transition, so
 * `ANTHROPIC_API_KEY` and every tool call stay entirely server-side; the
 * client only ever sees the final answer text plus, when a write-capable
 * tool was offered and used, a PENDING proposal's id/preview — never
 * anything that was actually created. `requireOrgAndActor` re-resolves the
 * real session actor on every call — the client cannot pass its own actor/
 * role, only the question, the prior turns' plain text, and which
 * specialist agent mode to scope the conversation to.
 */
export async function askControllerAction(orgSlug: string, input: unknown): Promise<AskControllerResult> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const parsed = AskSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "unavailable", reason: "Could not understand that request." };
    }

    const outcome = await FinancialControllerService.ask(
      actor,
      parsed.data.question,
      parsed.data.history as ConversationTurn[],
      parsed.data.agentMode,
    );
    if (outcome.status === "unavailable") return { status: "unavailable", reason: outcome.reason };
    return { status: "ok", answer: outcome.answer, proposals: outcome.proposals };
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export interface ConfirmProposalResult {
  status: "ok" | "error";
  message: string;
  resultEntityId?: string;
}

/**
 * The ONLY path that turns an AI-prepared proposal into a real DRAFT
 * invoice/bill/journal entry — triggered by a distinct, explicit "Create
 * this draft?" click in the chat UI, never automatically as part of
 * `askControllerAction`'s tool-call loop. `requireOrgAndActor` re-resolves
 * the real, authenticated actor, and `AIDraftProposalService.confirm` runs
 * the real permission check at the real creation call — a restricted-role
 * user who somehow saw this card is refused here exactly as the Sales/
 * Purchases/Journal UI would refuse them directly.
 */
export async function confirmDraftProposalAction(orgSlug: string, proposalId: string): Promise<ConfirmProposalResult> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      const result = await AIDraftProposalService.confirm(actor, proposalId);
      const kind = result.type === "INVOICE" ? "Invoice" : result.type === "BILL" ? "Bill" : "Journal entry";
      return { status: "ok", message: `${kind} ${result.resultLabel} created as a draft.`, resultEntityId: result.resultEntityId };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : "Could not create this draft." };
    }
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function dismissDraftProposalAction(orgSlug: string, proposalId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    await AIDraftProposalService.dismiss(actor, proposalId);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
