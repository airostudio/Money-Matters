import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./client";

/** The transaction-bound client type, inferred straight from `db.transaction`. */
export type TenantDb = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Opens a database transaction scoped to a single organization: sets the
 * `app.current_org_id` session variable that every tenant table's
 * Row-Level Security policy checks (see drizzle/0001_row_level_security.sql
 * and docs/security.md §2), then runs `callback` with a transaction-bound
 * client.
 *
 * This is the ONLY sanctioned way domain services touch the database.
 * There is deliberately no "give me a raw db handle" export from this
 * module — every read/write happens inside a tenant-scoped transaction, so
 * a missing `organizationId` filter in application code is still caught by
 * the database layer rather than silently returning cross-tenant rows.
 */
export async function withTenant<T>(
  organizationId: string,
  callback: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  if (!organizationId) {
    throw new Error("organizationId is required to open a tenant-scoped transaction.");
  }

  return db.transaction(async (tx) => {
    // set_config(..., true) is transaction-local, equivalent to SET LOCAL,
    // but (unlike SET LOCAL) accepts a bound parameter — SET does not.
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`);
    return callback(tx);
  });
}

/** Narrow, explicit failure for the "how did we get here without an org id" case. */
export function requireOrganizationId(
  organizationId: string | null | undefined,
): asserts organizationId is string {
  if (!organizationId) {
    throw new Error("organizationId is required for this operation.");
  }
}
