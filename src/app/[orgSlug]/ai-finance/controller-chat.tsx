"use client";

import { useState, useTransition } from "react";
import { Bot, Send, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { askControllerAction } from "./actions";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

const EXAMPLE_QUESTIONS = [
  "Who owes us money?",
  "How much did we spend last quarter?",
  "What's our cash position?",
  "Show me overdue bills",
];

/**
 * The AI Financial Controller's chat UI. A client component so a question
 * can be answered without a full page reload and the transcript can grow
 * across turns, but every bit of actual work — the Anthropic call, every
 * tool call, every permission check — happens in `askControllerAction`
 * (`"use server"`) on the server; nothing AI-related ever reaches the
 * browser except the final answer text.
 */
export function ControllerChat({ orgSlug }: { orgSlug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
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
      const result = await askControllerAction(orgSlug, { question: trimmed, history });
      if (result.status === "unavailable") {
        setUnavailableReason(result.reason ?? "The AI Financial Controller isn't available right now.");
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", text: result.answer ?? "" }]);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ask about your financials — the Controller only ever answers from your organization&apos;s real data,
                retrieved through the same permission-checked reports as the rest of the app, and always cites what
                it looked up.
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
                <div
                  className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                  }`}
                >
                  {m.text}
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
