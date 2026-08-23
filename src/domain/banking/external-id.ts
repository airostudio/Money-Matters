import { createHash } from "node:crypto";
import type { ParsedStatementRow } from "./types";

/**
 * Fills in `externalId` for rows a parser couldn't give a stable id of its
 * own (CSV and QIF have none; OFX's FITID is kept as-is). This is what
 * makes re-importing the same file, or an overlapping export from the same
 * bank, a no-op instead of duplicate transactions — see
 * bank_transactions_account_external_id_unique in the schema.
 *
 * A hash of (date, description, amount) alone would collide on genuinely
 * distinct transactions that just happen to look identical — two $5.50
 * coffees on the same day at the same merchant is not a rare case. Rows are
 * grouped by that content key and given an occurrence index within the
 * group (first "coffee $5.50" on 2026-01-01 gets index 0, the second gets
 * index 1, ...), so the *n*th occurrence of a repeated line always hashes
 * to the same id on every re-import, while two different occurrences never
 * collide with each other.
 */
export function assignExternalIds(rows: ParsedStatementRow[]): ParsedStatementRow[] {
  const occurrenceCounts = new Map<string, number>();

  return rows.map((row) => {
    if (row.externalId) return row;

    const contentKey = `${row.postedDate.toISOString().slice(0, 10)}|${row.description.trim().toLowerCase()}|${row.amount}`;
    const occurrence = occurrenceCounts.get(contentKey) ?? 0;
    occurrenceCounts.set(contentKey, occurrence + 1);

    const hash = createHash("sha256").update(`${contentKey}|${occurrence}`).digest("hex").slice(0, 32);
    return { ...row, externalId: `csv:${hash}` };
  });
}
