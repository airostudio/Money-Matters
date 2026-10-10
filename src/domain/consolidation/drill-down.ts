import type { LineSource } from "./types";

/**
 * Drill-down from a consolidated line to an entity's own account transactions.
 * The link is into the ENTITY's own page (`/{orgSlug}/accounting/accounts/...`),
 * which resolves the user's membership and role in that entity and re-checks
 * `journal:read` itself — the consolidated view never serves an entity's
 * transactions on its own authority. A computed line (retained earnings) has no
 * single account and so no link.
 */
export function entityAccountHref(
  source: Pick<LineSource, "organizationSlug" | "accountId">,
  range: { from?: string; to: string },
): string | null {
  if (!source.accountId) return null;
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  params.set("to", range.to);
  return `/${source.organizationSlug}/accounting/accounts/${source.accountId}/transactions?${params.toString()}`;
}
