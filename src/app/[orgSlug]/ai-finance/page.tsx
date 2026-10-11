import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ControllerChat } from "./controller-chat";

/**
 * The AI Financial Controller (Phase 6 Slice 1, master spec §7). Replaces
 * the earlier Phase 1-5 scaffold placeholder — see docs/ai-agents.md for the
 * tool-calling design and docs/roadmap.md for what's deferred to Slice 2
 * (specialist agents, autonomy levels, a command bar that drafts/posts
 * anything).
 */
export default async function AiFinancePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { q?: string };
}) {
  await requireOrgAndActor(params.orgSlug); // just confirms membership; the chat's own server action re-checks on every turn
  // The command palette's "Ask the AI Financial Controller: <query>" row lands here. The question is only PREFILLED into
  // the input (bounded in length); nothing is sent until the person presses Send, so a link can never make the AI run.
  const initialQuestion = typeof searchParams.q === "string" ? Array.from(searchParams.q.trim()).slice(0, 500).join("") : "";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Financial Controller</h1>
        <p className="text-sm text-muted-foreground">
          Ask a question in plain English. Every answer is retrieved through the same permission-checked reports as
          the rest of the app — see the{" "}
          <Link href={`/${params.orgSlug}/ai-finance/brief`} className="text-primary hover:underline">
            Daily Finance Brief
          </Link>{" "}
          for an always-on summary instead of asking.
        </p>
      </div>

      <ControllerChat orgSlug={params.orgSlug} initialQuestion={initialQuestion} />
    </div>
  );
}
