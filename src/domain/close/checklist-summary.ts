import type { PeriodChecklist } from "./checklist-types";
import { LOCK_LABELS } from "@/domain/ledger/period-lock";

/**
 * Plain-text rendering of an ALREADY-COMPUTED checklist, shared by the
 * read-only `close_status` controller tool and the optional AI "what remains"
 * commentary. It states the figures and which items are system-verified vs
 * human-signed-off, so neither consumer can blur the distinction, and it
 * contains nothing the checklist did not compute.
 */
export function checklistFacts(c: PeriodChecklist): string[] {
  const facts: string[] = [
    `Period ${c.period.label} (${c.period.start.slice(0, 10)} to ${c.period.end.slice(0, 10)}), current lock level: ${LOCK_LABELS[c.period.lockLevel]}.`,
    `Month close is ${c.progress.percent}% complete: ${c.progress.complete} of ${c.progress.applicable} applicable items passed. ${c.progress.formula}`,
  ];
  if (c.hiddenCount > 0) facts.push(`${c.hiddenCount} item group(s) are hidden from this user's role and not counted.`);
  if (c.blocking.length > 0) {
    facts.push(`BLOCKING (the period cannot be closed until fixed): ${c.blocking.map((i) => `${i.title} — ${i.detail}`).join(" | ")}`);
  }
  const attention = c.remaining.filter((i) => i.status === "ATTENTION");
  if (attention.length > 0) {
    facts.push(`NEEDS ATTENTION (closing requires acknowledging these): ${attention.map((i) => `${i.title} — ${i.detail}`).join(" | ")}`);
  }
  const manual = c.remaining.filter((i) => i.status === "MANUAL");
  if (manual.length > 0) {
    facts.push(`AWAITING A HUMAN SIGN-OFF (the system cannot verify these): ${manual.map((i) => i.title).join("; ")}.`);
  }
  const signed = c.items.filter((i) => i.kind === "MANUAL" && i.signoff);
  if (signed.length > 0) {
    facts.push(
      `SIGNED OFF BY A PERSON (not system-verified): ${signed.map((i) => `${i.title} by ${i.signoff!.signedByName ?? "a user"} on ${i.signoff!.signedAt.slice(0, 10)}`).join("; ")}.`,
    );
  }
  const systemPassed = c.items.filter((i) => i.kind === "AUTOMATIC" && i.status === "PASSED");
  if (systemPassed.length > 0) facts.push(`VERIFIED BY THE SYSTEM from live data: ${systemPassed.map((i) => i.title).join("; ")}.`);
  const na = c.items.filter((i) => i.status === "NOT_APPLICABLE");
  if (na.length > 0) facts.push(`NOT APPLICABLE: ${na.map((i) => i.title).join("; ")}.`);
  if (c.remaining.length === 0) facts.push("Nothing remains: every applicable item has passed.");
  return facts;
}
