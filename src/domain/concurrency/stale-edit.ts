/**
 * Lightweight optimistic concurrency for editable drafts.
 *
 * An edit form carries the `updatedAt` of the record as it was when the form
 * was rendered (its "edit version"). When the form is saved, the service
 * compares it with the record's current `updatedAt` while holding a row lock;
 * if someone else saved in between, the save is refused with `StaleEditError`
 * rather than silently overwriting their work.
 *
 * Coverage today: DRAFT invoices and DRAFT bills only (the highest-traffic
 * editable documents). Posted documents are already immutable. Other editable
 * entities (quotes, contacts, projects, budgets, ...) are NOT yet covered and
 * remain last-write-wins - see docs/roadmap.md "Shared access UX".
 */

/**
 * The token a form carries. Millisecond ISO text, because that is the precision
 * a JavaScript Date round-trips; Postgres keeps microseconds, so both sides are
 * compared through `Date`, never as raw database values.
 */
export function editVersionOf(updatedAt: Date): string {
  return updatedAt.toISOString();
}

/**
 * True when the version the form was opened with no longer matches. A missing
 * (`undefined`) expectation means "caller does not take part in the check"
 * (programmatic callers); a present-but-unparseable one is stale, never
 * silently accepted.
 */
export function isStaleEdit(expectedVersion: string | undefined, currentUpdatedAt: Date): boolean {
  if (expectedVersion === undefined) return false;
  const expected = Date.parse(expectedVersion);
  if (Number.isNaN(expected)) return true;
  return expected !== currentUpdatedAt.getTime();
}

/**
 * A timestamp for the row that is strictly after what was there, so two saves
 * that land in the same millisecond still change the edit version.
 */
export function nextUpdatedAt(previous: Date, now: Date = new Date()): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}

/** "2026-10-05 14:03 UTC" - deterministic, timezone-independent wording for the message. */
export function formatChangedAt(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export class StaleEditError extends Error {
  constructor(
    public readonly entityName: "invoice" | "bill",
    public readonly documentNumber: string,
    public readonly changedBy: string | null,
    public readonly changedAt: Date,
  ) {
    super(
      `This ${entityName} (${documentNumber}) was changed by ${changedBy ?? "someone else"} at ${formatChangedAt(changedAt)} ` +
        `since you opened it, so your changes were not saved and nothing was overwritten. ` +
        `Reload the page to see the latest version, then make your edits again.`,
    );
    this.name = "StaleEditError";
  }
}
