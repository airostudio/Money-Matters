import { PeriodLockedError } from "@/domain/ledger/errors";
import type { PostOptions } from "@/domain/ledger/posting-service";

/**
 * Shared glue for the UI's period-lock feedback (master spec §79: an error
 * must say what happened, the consequence, and who can fix it — never a
 * dead end). `lockFailureQuery` turns a posting rejection into the query
 * string a detail page renders: the explained message plus `lock=override`
 * when THIS user could post anyway with a reason (soft lock + the
 * `period:override_soft` permission — decided server-side by the posting
 * engine, never by this flag) or `lock=blocked` otherwise.
 */
export function lockFailureQuery(error: unknown): string | null {
  if (!(error instanceof PeriodLockedError)) return null;
  return `error=${encodeURIComponent(error.message)}&lock=${error.canOverrideWithReason ? "override" : "blocked"}`;
}

/** Reads the optional override reason a "Post anyway" form submits. The posting engine decides whether the actor may use it. */
export function postOptionsFromForm(formData?: FormData): PostOptions | undefined {
  const reason = formData?.get("lockOverrideReason");
  return typeof reason === "string" && reason.trim() ? { lockOverrideReason: reason.trim() } : undefined;
}
