/**
 * Outcome messages for the automation settings page. The query string carries a short fixed CODE (plus small integers),
 * and the text is composed here, so a crafted link can never make the page display attacker-chosen prose.
 */
export function noticeText(search: { notice?: string; ok?: string; failed?: string; skipped?: string; more?: string }): { tone: "ok" | "warn"; text: string } | null {
  const int = (v: string | undefined) => (v && /^\d{1,4}$/.test(v) ? Number(v) : 0);
  switch (search.notice) {
    case "created":
      return { tone: "ok", text: "Rule created. It will react to events from now on." };
    case "enabled":
      return { tone: "ok", text: "Rule switched on. You are now its authoriser, and it will react to events from now on." };
    case "paused":
      return { tone: "ok", text: "Rule paused." };
    case "deleted":
      return { tone: "ok", text: "Rule deleted. Its run history is kept." };
    case "confirm_needed":
      return { tone: "warn", text: "Tick the confirmation box to switch on a rule that creates draft records." };
    case "cannot_enable":
      return { tone: "warn", text: "This rule cannot be switched on as it is. Edit or recreate it." };
    case "all_paused":
      return { tone: "ok", text: "All automations are paused. Nothing will run, from any source, until you resume them." };
    case "all_resumed":
      return { tone: "ok", text: "Automations resumed. Events that happened while they were paused will not be replayed." };
    case "ran": {
      const ok = int(search.ok);
      const failed = int(search.failed);
      const skipped = int(search.skipped);
      return {
        tone: failed > 0 ? "warn" : "ok",
        text: `Ran automations: ${ok} succeeded, ${failed} failed, ${skipped} skipped.${search.more === "1" ? " There is more waiting - press Run automations now again." : ""}`,
      };
    }
    case "run_paused":
      return { tone: "warn", text: "Nothing ran: all automations are paused." };
    case "run_archived":
      return { tone: "warn", text: "Nothing ran: this company is archived." };
    case "run_busy":
      return { tone: "warn", text: "Another run is already in progress for this company. Try again in a moment." };
    default:
      return null;
  }
}
