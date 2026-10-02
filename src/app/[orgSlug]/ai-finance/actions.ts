"use server";

import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { FinancialControllerService, type ConversationTurn } from "@/domain/ai-controller/financial-controller-service";

const TurnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
const AskSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z.array(TurnSchema).max(40),
});

export interface AskControllerResult {
  status: "ok" | "unavailable";
  answer?: string;
  reason?: string;
}

/**
 * The AI Financial Controller's server action — called directly from the
 * client chat component (`controller-chat.tsx`) via a React transition, so
 * `ANTHROPIC_API_KEY` and every tool call stay entirely server-side; the
 * client only ever sees the final answer text. `requireOrgAndActor` re-
 * resolves the real session actor on every call — the client cannot pass
 * its own actor/role, only the question and the prior turns' plain text.
 */
export async function askControllerAction(orgSlug: string, input: unknown): Promise<AskControllerResult> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const parsed = AskSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "unavailable", reason: "Could not understand that request." };
  }

  const outcome = await FinancialControllerService.ask(actor, parsed.data.question, parsed.data.history as ConversationTurn[]);
  if (outcome.status === "unavailable") return { status: "unavailable", reason: outcome.reason };
  return { status: "ok", answer: outcome.answer };
}
