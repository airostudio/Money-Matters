/**
 * Outcome messages for the webhook settings pages. The query string carries a short fixed CODE (plus small integers), and
 * the text is composed here, so a crafted link can never make the page display attacker-chosen prose.
 */
export function noticeText(search: { notice?: string; status?: string; sent?: string; failed?: string; class?: string }): { tone: "ok" | "warn"; text: string } | null {
  const int = (v: string | undefined) => (v && /^\d{1,4}$/.test(v) ? Number(v) : 0);
  const errorClass = (search.class ?? "").replace(/[^a-z_]/g, "").slice(0, 30);
  switch (search.notice) {
    case "saved":
      return { tone: "ok", text: "Saved." };
    case "invalid_input":
      return { tone: "warn", text: "That change was not saved: check the URL (public https address on port 443) and choose at least one event." };
    case "test_ok":
      return { tone: "ok", text: `Test event delivered (your endpoint answered HTTP ${int(search.status)}). Check that it verified the signature.` };
    case "test_failed":
      return { tone: "warn", text: `Test event not delivered${int(search.status) ? ` (HTTP ${int(search.status)})` : ""}${errorClass ? `: ${errorClass.replace(/_/g, " ")}` : ""}. See the attempt log for the excerpt of the response.` };
    case "test_refused":
      return { tone: "warn", text: "A test event could not be sent: the subscription is disabled or webhooks are not configured." };
    case "dispatched":
      return { tone: "ok", text: `Sent ${int(search.sent)} and failed ${int(search.failed)} delivery attempt(s). Anything that failed is rescheduled with backoff.` };
    case "dispatch_disabled":
      return { tone: "warn", text: "Nothing was sent: webhooks are disabled until the platform operator configures the signing-secret encryption key." };
    case "replay_ok":
      return { tone: "ok", text: "Replayed: your endpoint accepted the event." };
    case "replay_failed":
      return { tone: "warn", text: `Replayed, but your endpoint did not accept it${int(search.status) ? ` (HTTP ${int(search.status)})` : ""}.` };
    case "replay_refused":
      return { tone: "warn", text: "This delivery cannot be replayed right now (the subscription is disabled, the delivery is being sent, or webhooks are not configured)." };
    default:
      return null;
  }
}
