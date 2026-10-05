import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./client";
import type { TenantDb } from "./tenant";

/**
 * Opens a database transaction scoped to a single USER: sets the
 * `app.current_user_id` session variable that the consolidation-group tables'
 * Row-Level Security policies check (`owner_user_id = app.current_user_id`;
 * drizzle/0039_consolidation_slice4_row_level_security.sql, docs/security.md
 * section 12).
 *
 * This is the sibling of `withTenant` and exactly as narrow: ONE user id per
 * transaction, never a list. It deliberately does NOT set `app.current_org_id`,
 * so inside this transaction no tenant table (journals, invoices, ...) returns
 * a single row — a consolidation group's own configuration is reachable here,
 * an organization's books are not. Reading an entity's books always goes
 * through `withTenant(entityId)` in a separate, sequential transaction using
 * the user's real role in that entity.
 */
export type UserScopeDb = TenantDb;

export async function withUserScope<T>(
  userId: string,
  callback: (tx: UserScopeDb) => Promise<T>,
): Promise<T> {
  if (!userId) {
    throw new Error("userId is required to open a user-scoped transaction.");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return callback(tx);
  });
}
