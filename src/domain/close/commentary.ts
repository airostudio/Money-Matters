import "server-only";
import type { PeriodChecklist } from "./checklist-types";
import { checklistFacts } from "./checklist-summary";

/**
 * Optional AI "what remains" plain-language summary over an ALREADY-COMPUTED
 * checklist — the same lightweight pattern as the management pack, daily
 * brief and forecast commentary: the model is handed only what the checklist
 * computed, is told never to calculate or introduce a figure, and the whole
 * thing is omitted (`null`) when `ANTHROPIC_API_KEY` is unset or the call
 * fails. It is read-only and never a source of facts; it cannot close, lock,
 * reopen or sign off anything (fiscal period close is a permanently
 * human-gated critical action — docs/ai-agents.md).
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM =
  "You write a short (3-5 sentence) plain-English summary of what remains to be done before a small business can close a month. " +
  "Use ONLY the facts given — never calculate, restate with a different value, or introduce any number or item that is not listed. " +
  "Say clearly which items are blocking, which need attention, and which are waiting on a person's sign-off. Items signed off by a person " +
  "are NOT verified by the system — never describe them as verified. You cannot close, lock or change anything; do not offer to.";

export const CloseCommentaryService = {
  /** `null` when `ANTHROPIC_API_KEY` is unset or the call failed. */
  async forChecklist(checklist: PeriodChecklist): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey, timeout: 15_000 });
      const message = await client.messages.create({
        model: process.env.ANTHROPIC_CLOSE_COMMENTARY_MODEL || DEFAULT_MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: `Here are the already-computed close checklist facts:\n\n${checklistFacts(checklist).join("\n")}` }],
      });
      const textBlock = message.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      return textBlock?.text.trim() || null;
    } catch {
      return null;
    }
  },
};
