import "server-only";
import { withTenant } from "@/db/tenant";
import { type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { buildControllerTools, type ControllerToolDefinition, type ToolCitation } from "./controller-tools";
import { buildWriteTools } from "./write-tools";
import { AutonomySettingsService } from "./autonomy";
import { AutoExecutionService } from "./auto-execution-service";
import { AGENT_MODES, type AgentMode } from "./specialist-agents";
import type { DraftProposalPreview } from "./draft-proposal-service";

/**
 * The AI Financial Controller (master spec §7, Phase 6 Slice 1): a
 * persistent conversational assistant over a FIXED set of read-only,
 * permission-checked tools (`controller-tools.ts`). This module is the
 * orchestration loop: Intent (the user's question) → the model picks a tool
 * → we execute it with the real actor's permissions → the result goes back
 * to the model → repeat, up to a round cap → a final, narrated answer with
 * deterministic source citations. Exactly master spec §50's "Intent →
 * Permission → Validation → Tool → Result → Audit" pipeline, and
 * docs/ai-agents.md §2's diagram, now actually built.
 *
 * **What this slice deliberately does NOT build** (see docs/roadmap.md):
 * no specialist agents (Bookkeeping/AR/AP/Payroll/Tax/FP&A) sitting behind
 * this one, no autonomy levels, no command bar that drafts or posts
 * anything. Every tool here is read-only — this is an information
 * assistant, not an action-taking one.
 *
 * **Conversation state.** There is no server-side session store for a
 * conversation yet (no job-queue/session infrastructure exists in this
 * codebase beyond what Phase 1-5 built). The caller (the chat UI's server
 * action) keeps the plain-text transcript of prior turns and passes it back
 * in on every call as `history` — enough for the model to use conversational
 * context ("and last month?") without this module needing to persist
 * anything. What is NOT preserved across turns is the tool_use/tool_result
 * block detail of a previous turn's own internal tool-call loop — only its
 * final narrated answer. This is a deliberate simplification documented
 * here, not an oversight: the alternative (storing full raw tool-use
 * transcripts across turns) would grow unboundedly and isn't needed for a
 * useful multi-turn experience.
 */

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOOL_ROUNDS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface PendingDraftProposal {
  id: string;
  preview: DraftProposalPreview;
}

export type ControllerOutcome =
  | { status: "ok"; answer: string; citations: ToolCitation[]; proposals: PendingDraftProposal[] }
  | { status: "unavailable"; reason: string };

function systemPrompt(toolNames: string[], hasWriteTools: boolean, agentAddendum: string): string {
  return [
    "You are the AI Financial Controller for a small business accounting platform.",
    `You may ONLY learn financial facts by calling one of these tools: ${toolNames.join(", ")}.`,
    "You MUST call a tool before stating any financial figure, balance, total, count, date, invoice/bill/claim detail, or name of a customer/supplier who owes or is owed money. Never state a number from memory or by guessing — if you are not sure which tool applies, call the closest one and explain what you found.",
    "If a tool call is refused because the user's role does not have permission, say so plainly and do not attempt another tool or guess at the answer from somewhere else — report the refusal exactly as given.",
    "If a question is not about this organization's financial data (e.g. small talk), you may answer directly without a tool.",
    "When you have enough information, give a concise, plain-English final answer. Do not repeat long raw tables back — summarize them. You do not need to list your sources yourself; the application appends them automatically.",
    hasWriteTools
      ? "Some of your tools PREPARE a draft invoice/bill/journal entry for human review — they never create or post anything by themselves. After calling one, tell the user you've prepared a draft and that they need to review and explicitly confirm it; never say it has been created, entered, or posted. Never call a prepare_draft_* tool unless the user clearly asked you to draft/prepare/create that specific invoice, bill, or journal entry — do not prepare one speculatively."
      : "You do not have any tool that creates, drafts, or posts anything — you can only look things up and explain them. If asked to create, draft, invoice, or post something, say plainly that this isn't something you can do here (it may require a higher autonomy level the organization hasn't enabled, or isn't supported from chat).",
    agentAddendum,
  ]
    .filter(Boolean)
    .join(" ");
}

const MONEY_LIKE = /[$£€]\s?\d|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/;

/**
 * Master spec §2's "never allow AI to silently invent financial information"
 * as a runtime guard, not just a prompt instruction: if the model produced a
 * final answer in the very first round — before any tool was ever called in
 * this turn — and that answer contains something that looks like a currency
 * figure, we do not trust it. This is a deliberately narrow heuristic (it
 * cannot catch a hallucinated figure stated in words, e.g. "about twelve
 * thousand dollars") — it exists to catch the common, cheap failure mode of
 * the model answering a numeric question from its own "knowledge" instead of
 * calling a tool, which is exactly the system-prompt instruction above
 * failing. See `src/tests/unit/ai-controller/financial-controller-loop.test.ts`.
 */
function looksLikeUncitedFigure(text: string): boolean {
  return MONEY_LIKE.test(text);
}

function dedupeCitations(citations: ToolCitation[]): ToolCitation[] {
  const seen = new Set<string>();
  const out: ToolCitation[] = [];
  for (const c of citations) {
    const key = `${c.tool}|${c.description}|${c.periodLabel ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function formatSources(citations: ToolCitation[]): string {
  if (citations.length === 0) return "";
  const lines = dedupeCitations(citations).map((c) => `- ${c.description}${c.periodLabel ? `, ${c.periodLabel}` : ""}`);
  return `\n\nSources:\n${lines.join("\n")}`;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string; [k: string]: unknown };

async function runToolCallLoop(
  actor: Actor,
  tools: ControllerToolDefinition[],
  apiKey: string,
  messages: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }>,
  hasWriteTools: boolean,
  agentAddendum: string,
): Promise<{
  answer: string;
  citations: ToolCitation[];
  toolCallLog: Array<{ tool: string; ok: boolean }>;
  proposals: PendingDraftProposal[];
}> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  const model = process.env.ANTHROPIC_CONTROLLER_MODEL || DEFAULT_MODEL;
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as any }));
  const system = systemPrompt(tools.map((t) => t.name), hasWriteTools, agentAddendum);

  const citations: ToolCitation[] = [];
  const toolCallLog: Array<{ tool: string; ok: boolean }> = [];
  const proposals: PendingDraftProposal[] = [];
  let anyToolCalled = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const forceFinal = round === MAX_TOOL_ROUNDS - 1;
    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: messages as any,
      tools: apiTools,
      tool_choice: forceFinal ? { type: "none" } : { type: "auto" },
    });

    const content = message.content as unknown as AnthropicContentBlock[];
    const toolUses = content.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      const text = content
        .filter((b): b is AnthropicTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (!anyToolCalled && looksLikeUncitedFigure(text)) {
        return {
          answer:
            "I can't answer that from memory — let me know a bit more specifically what you'd like (e.g. a period or account), and I'll look it up in your actual records.",
          citations: [],
          toolCallLog,
          proposals,
        };
      }

      return { answer: text || "I didn't have anything more to add.", citations, toolCallLog, proposals };
    }

    anyToolCalled = true;
    messages.push({ role: "assistant", content });

    const toolResults: AnthropicContentBlock[] = [];
    for (const toolUse of toolUses) {
      const def = tools.find((t) => t.name === toolUse.name);
      if (!def) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Unknown tool "${toolUse.name}".` } as any);
        toolCallLog.push({ tool: toolUse.name, ok: false });
        continue;
      }

      const parsed = def.argsSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Invalid arguments for ${def.name}: ${parsed.error.message}`,
        } as any);
        toolCallLog.push({ tool: def.name, ok: false });
        continue;
      }

      const outcome = await def.execute(actor, parsed.data);
      toolCallLog.push({ tool: def.name, ok: outcome.ok });
      if (outcome.ok) {
        citations.push(outcome.citation);
        if (outcome.proposal) proposals.push(outcome.proposal);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: outcome.summary } as any);
      } else {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: outcome.error } as any);
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: "I had to stop after gathering several reports — please ask a more specific follow-up and I'll continue from there.",
    citations,
    toolCallLog,
    proposals,
  };
}

export const FinancialControllerService = {
  /**
   * One conversational turn. `history` is the plain-text transcript of
   * prior turns in this chat (see this module's doc comment on why it's
   * text-only, not the raw tool-use blocks). Every tool call this turn makes
   * uses `actor` — the real, authenticated user — never an elevated or
   * service-level identity.
   *
   * `agentMode` (default `"GENERAL"`) narrows the tool subset and system
   * prompt per `specialist-agents.ts` — it never widens what a plain
   * Controller conversation could already do. Write-capable tools
   * (`prepare_draft_*`) are only even constructed, let alone offered to the
   * model, when the organization's autonomy level (`AutonomySettingsService`)
   * is >= 2 — this is checked BEFORE the tool list is built, not only when a
   * tool is called, so a Level 0/1 organization's conversation never has a
   * `prepare_draft_*` tool in its `tools` array at all, regardless of
   * `agentMode`.
   */
  async ask(
    actor: Actor,
    question: string,
    history: ConversationTurn[] = [],
    agentMode: AgentMode = "GENERAL",
  ): Promise<ControllerOutcome> {
    const trimmed = question.trim();
    if (!trimmed) return { status: "unavailable", reason: "Please type a question first." };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        status: "unavailable",
        reason: "The AI Financial Controller isn't configured in this environment.",
      };
    }

    const mode = AGENT_MODES[agentMode] ?? AGENT_MODES.GENERAL;

    // Phase 6 Slice 3: with no job-queue infrastructure in this codebase
    // (see docs/roadmap.md), a conversation turn is one of the natural
    // touchpoints that drives Level 3/4 auto-execution (the Settings page's
    // "Run automated actions now" button is the other) — see
    // `auto-execution-service.ts`'s doc comment. This is checked and run
    // BEFORE anything else below, and failing it never blocks the user's
    // actual question: a Level 0-2 organization (the overwhelming common
    // case) pays for nothing but a fresh, uncached policy check per action
    // type inside `runPendingAutoExecutions` itself.
    try {
      await AutoExecutionService.runPendingAutoExecutions(actor);
    } catch {
      // Never let an auto-execution failure block the user's question.
    }

    // `run_report`'s tool description is enriched with the organization's
    // real dimension names (see `controller-tools.ts`), but not every role
    // that can otherwise use the Controller holds `dimension:read` (e.g.
    // PAYROLL_MANAGER, EMPLOYEE — see roles.ts). That must never crash the
    // whole conversation for them; it just means `run_report` won't mention
    // any dimension by name for that actor, which is the correct, narrower
    // behavior for a role that couldn't see dimensions in the UI either.
    let dimensions: Awaited<ReturnType<typeof DimensionService.listActive>> = [];
    try {
      dimensions = await DimensionService.listActive(actor);
    } catch {
      // Fall through with no dimensions.
    }
    const allReadTools = buildControllerTools(dimensions);
    const readTools = mode.readToolNames ? allReadTools.filter((t) => mode.readToolNames!.includes(t.name)) : allReadTools;

    // THE autonomy gate: write tools are constructed at all only at Level 2+,
    // and even then only the subset this agent mode names — see this
    // method's doc comment and docs/ai-agents.md.
    const autonomyLevel = await AutonomySettingsService.getLevel(actor.organizationId);
    const model = process.env.ANTHROPIC_CONTROLLER_MODEL || DEFAULT_MODEL;
    const allWriteTools = autonomyLevel >= 2 ? buildWriteTools(trimmed, model) : [];
    const writeTools = allWriteTools.filter((t) => mode.writeToolNames.includes(t.name));
    const tools = [...readTools, ...writeTools];

    const messages: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: "user" as const, content: trimmed },
    ];

    let result: Awaited<ReturnType<typeof runToolCallLoop>>;
    try {
      result = await runToolCallLoop(actor, tools, apiKey, messages, writeTools.length > 0, mode.systemPromptAddendum);
    } catch {
      // Same discipline as every other AI integration in this codebase: never
      // surface the raw error, timeout, or network failure.
      return {
        status: "unavailable",
        reason: "The AI Financial Controller is temporarily unavailable. Try the reports directly.",
      };
    }

    if (result.toolCallLog.length > 0) {
      // Best-effort: this is a read-only conversational answer, not a
      // mutation an audit failure should roll back (contrast
      // `OnboardingService.applyChartOfAccounts`, where the audit write
      // shares the mutation's own transaction on purpose). The user still
      // gets their already-computed answer even if the audit write itself
      // fails for some reason.
      try {
        await withTenant(actor.organizationId, (tx) =>
          AuditService.record(tx, { ...actor, type: "AI" }, {
            action: "ai_controller.query_answered",
            entityType: "AIControllerConversation",
            entityId: actor.organizationId,
            after: {
              question: trimmed,
              toolCalls: result.toolCallLog,
            },
            metadata: {
              askedByUserId: actor.userId,
              model: process.env.ANTHROPIC_CONTROLLER_MODEL || DEFAULT_MODEL,
            },
          }),
        );
      } catch {
        // Swallowed — see comment above.
      }
    }

    return {
      status: "ok",
      answer: result.answer + formatSources(result.citations),
      citations: dedupeCitations(result.citations),
      proposals: result.proposals,
    };
  },
};
