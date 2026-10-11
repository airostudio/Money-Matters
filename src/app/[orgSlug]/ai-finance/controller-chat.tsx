"use client";

import { useState, useTransition } from "react";
import { Bot, Check, Send, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  askControllerAction,
  confirmDraftProposalAction,
  dismissDraftProposalAction,
  type PendingProposal,
} from "./actions";
import { AGENT_MODES, AGENT_MODE_IDS, DEFERRED_AGENTS, type AgentMode } from "@/domain/ai-controller/specialist-agents";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  proposals?: PendingProposal[];
}

const EXAMPLE_QUESTIONS = [
  "Who owes us money?",
  "How much did we spend last quarter?",
  "What's our cash position?",
  "Show me overdue bills",
];

/** A proposal's own lifecycle within this one browser tab — never persisted client-side; the real status lives in `ai_draft_proposals`. */
type ProposalUiStatus = "pending" | "confirming" | "confirmed" | "dismissed" | "error";

function ProposalCard({
  proposal,
  orgSlug,
  onResolved,
}: {
  proposal: PendingProposal;
  orgSlug: string;
  onResolved: (id: string, status: ProposalUiStatus, message?: string) => void;
}) {
  const [status, setStatus] = useState<ProposalUiStatus>("pending");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    if (isPending) return;
    setStatus("confirming");
    startTransition(async () => {
      const result = await confirmDraftProposalAction(orgSlug, proposal.id);
      const next: ProposalUiStatus = result.status === "ok" ? "confirmed" : "error";
      setStatus(next);
      setMessage(result.message);
      onResolved(proposal.id, next, result.message);
    });
  }

  function dismiss() {
    if (isPending) return;
    setStatus("dismissed");
    startTransition(async () => {
      await dismissDraftProposalAction(orgSlug, proposal.id);
      onResolved(proposal.id, "dismissed");
    });
  }

  const { preview } = proposal;

  return (
    <div className="max-w-[90%] rounded-lg border border-border bg-background p-3 text-sm">
      <p className="font-medium">{preview.headline}</p>
      {preview.memo && <p className="mt-1 text-xs text-muted-foreground">Memo: {preview.memo}</p>}
      {preview.lines.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {preview.lines.map((line, i) => (
            <li key={i}>
              {line.description} — {line.accountLabel}
              {line.amount ? ` — ${line.amount} ${preview.currency}` : ""}
              {line.debit ? ` — debit ${line.debit}` : ""}
              {line.credit ? ` — credit ${line.credit}` : ""}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-500">
        Nothing has been created yet. Review the details above, then choose:
      </p>

      {status === "pending" || status === "confirming" ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" onClick={confirm} disabled={isPending}>
            <Check className="mr-1 size-3.5" /> Create this draft
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={dismiss} disabled={isPending}>
            <X className="mr-1 size-3.5" /> Dismiss
          </Button>
        </div>
      ) : status === "confirmed" ? (
        <p className="mt-3 text-sm font-medium text-emerald-600 dark:text-emerald-500">{message}</p>
      ) : status === "error" ? (
        <p className="mt-3 text-sm text-destructive">{message}</p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Dismissed — nothing was created.</p>
      )}
    </div>
  );
}

/**
 * The AI Financial Controller's chat UI. A client component so a question
 * can be answered without a full page reload and the transcript can grow
 * across turns, but every bit of actual work — the Anthropic call, every
 * tool call, every permission check — happens in `askControllerAction`
 * (`"use server"`) on the server; nothing AI-related ever reaches the
 * browser except the final answer text and, when a write tool was used, a
 * PENDING proposal's preview. A proposal is never auto-created: creating it
 * is always a second, explicit click on `ProposalCard`'s own "Create this
 * draft" button, calling `confirmDraftProposalAction` — a completely
 * separate server action from the one that ran the conversation turn.
 */
export function ControllerChat({ orgSlug, initialQuestion = "" }: { orgSlug: string; initialQuestion?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialQuestion);
  const [agentMode, setAgentMode] = useState<AgentMode>("GENERAL");
  const [isPending, startTransition] = useTransition();
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isPending) return;
    setUnavailableReason(null);
    const history = messages;
    setMessages([...history, { role: "user", text: trimmed }]);
    setInput("");

    startTransition(async () => {
      const result = await askControllerAction(orgSlug, { question: trimmed, history, agentMode });
      if (result.status === "unavailable") {
        setUnavailableReason(result.reason ?? "The AI Financial Controller isn't available right now.");
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", text: result.answer ?? "", proposals: result.proposals }]);
    });
  }

  function handleProposalResolved() {
    // Nothing to reconcile client-side — ProposalCard owns its own status
    // display, and the server is the only source of truth for what was
    // actually created. This hook exists so a future feature (e.g. a
    // "pending proposals" badge) has a single place to hang off.
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Mode:</span>
        {AGENT_MODE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setAgentMode(id)}
            className={`rounded-full border px-3 py-1 text-xs ${
              agentMode === id ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted"
            }`}
            title={AGENT_MODES[id].description}
          >
            {AGENT_MODES[id].label}
          </button>
        ))}
        {DEFERRED_AGENTS.map((d) => (
          <span
            key={d.label}
            title={d.reason}
            className="cursor-not-allowed rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground/50"
          >
            {d.label} (not yet built)
          </span>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ask about your financials — the Controller only ever answers from your organization&apos;s real data,
                retrieved through the same permission-checked reports as the rest of the app, and always cites what
                it looked up. If this organization has enabled Level 2 autonomy, it can also prepare — never create —
                a draft invoice, bill, or journal entry for you to review.
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => ask(q)}
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                {m.role === "assistant" && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Bot className="size-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex max-w-[80%] flex-col gap-2">
                  <div
                    className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                    }`}
                  >
                    {m.text}
                  </div>
                  {m.proposals?.map((p) => (
                    <ProposalCard key={p.id} proposal={p} orgSlug={orgSlug} onResolved={handleProposalResolved} />
                  ))}
                </div>
                {m.role === "user" && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <User className="size-4 text-primary" />
                  </div>
                )}
              </div>
            ))}
            {isPending && <p className="text-xs text-muted-foreground">Checking your records…</p>}
            {unavailableReason && <p className="text-sm text-destructive">{unavailableReason}</p>}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question about your financials…"
              className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              disabled={isPending}
            />
            <Button type="submit" disabled={isPending || !input.trim()}>
              <Send className="size-4" />
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
