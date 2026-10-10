import "server-only";
import { workpaperFacts } from "./assistant-views";
import type { WorkpaperDetail } from "./workpaper-service";

/**
 * Optional AI summary of an ALREADY-COMPUTED workpaper — the same lightweight pattern as the close
 * commentary, management pack and forecast commentary: the model is handed only the facts the
 * workpaper computed (balance, schedule total, difference, counts), is told never to calculate or
 * introduce a figure, and the whole thing is omitted (`null`) when `ANTHROPIC_API_KEY` is unset or the
 * call fails. It is read-only: it cannot sign off, post, reopen or change anything, and it is a reading
 * aid, never a source of facts or a substitute for the reviewer.
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM =
  "You write a short (3-5 sentence) plain-English summary of an accountant's balance-sheet reconciliation workpaper for the reviewer. " +
  "Use ONLY the facts given — never calculate, restate with a different value, or introduce any number, account or item that is not listed. " +
  "State whether the schedule agrees to the ledger and, if not, the difference exactly as given; mention open review notes and unposted proposed adjustments. " +
  "Proposed adjustments are notes only and are never posted by this system. You cannot sign off, post or change anything; do not offer to.";

export const WorkpaperCommentaryService = {
  /** `null` when `ANTHROPIC_API_KEY` is unset or the call failed. */
  async forWorkpaper(detail: WorkpaperDetail): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey, timeout: 15_000 });
      const message = await client.messages.create({
        model: process.env.ANTHROPIC_WORKPAPER_COMMENTARY_MODEL || DEFAULT_MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: `Here are the already-computed workpaper facts:\n\n${workpaperFacts(detail).join("\n")}` }],
      });
      const textBlock = message.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      return textBlock?.text.trim() || null;
    } catch {
      return null;
    }
  },
};
