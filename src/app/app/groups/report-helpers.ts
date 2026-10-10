import "server-only";
import { notFound } from "next/navigation";
import { GroupNotFoundError, GroupTooLargeError, MixedCurrencyError } from "@/domain/consolidation/errors";

/**
 * Runs a consolidated report for a page: an unknown/not-yours group is a 404,
 * and the two refusals a user can fix (mixed base currencies, too many entities)
 * become a message on the page instead of an error screen. Anything else is a
 * real failure and propagates.
 */
export async function runConsolidatedReport<T>(run: () => Promise<T>): Promise<{ report: T; error: null } | { report: null; error: string }> {
  try {
    return { report: await run(), error: null };
  } catch (error) {
    if (error instanceof GroupNotFoundError) notFound();
    if (error instanceof MixedCurrencyError || error instanceof GroupTooLargeError) {
      return { report: null, error: error.message };
    }
    throw error;
  }
}
