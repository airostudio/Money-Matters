import { and, eq } from "drizzle-orm";
import { practiceMembers, practiceRoster } from "@/db/schema";
import type { UserScopeDb } from "@/db/user-scope";
import { PracticeNotFoundError, PracticePermissionError } from "./errors";
import { PRACTICE_ROLE_RANK, type PracticeActor, type PracticeRole } from "./types";

export interface PracticeContext {
  practiceId: string;
  userId: string;
  role: PracticeRole;
}

/** True when `actual` is at least `required` in the practice-role order STAFF < MANAGER < PARTNER. */
export function practiceRoleAtLeast(actual: PracticeRole, required: PracticeRole): boolean {
  return PRACTICE_ROLE_RANK[actual] >= PRACTICE_ROLE_RANK[required];
}

/** Throws PracticePermissionError unless the context's role is at least `required`. */
export function assertPracticeRole(ctx: PracticeContext, required: PracticeRole, action?: string): void {
  if (!practiceRoleAtLeast(ctx.role, required)) {
    throw new PracticePermissionError(required, ctx.role, action);
  }
}

/**
 * The practice-role assertion helper every practice service goes through
 * (the practice analogue of `assertPermission` for an organization Actor).
 *
 * `load` resolves the caller's ACTIVE membership of the practice from inside the
 * caller's own user-scoped transaction. Row-level security would already hide a
 * practice from a non-member, so this is the same fact stated explicitly: a
 * practice the user does not belong to and one that does not exist are
 * indistinguishable (PracticeNotFoundError).
 */
export const PracticeAccess = {
  async load(tx: UserScopeDb, actor: PracticeActor, practiceId: string): Promise<PracticeContext> {
    const [row] = await tx
      .select({ role: practiceMembers.role })
      .from(practiceMembers)
      .where(
        and(
          eq(practiceMembers.practiceId, practiceId),
          eq(practiceMembers.userId, actor.userId),
          eq(practiceMembers.status, "ACTIVE"),
        ),
      );
    if (!row) throw new PracticeNotFoundError();
    return { practiceId, userId: actor.userId, role: row.role };
  },

  /** Loads the caller's context and asserts a minimum role in one step. */
  async require(
    tx: UserScopeDb,
    actor: PracticeActor,
    practiceId: string,
    required: PracticeRole,
    action?: string,
  ): Promise<PracticeContext> {
    const ctx = await PracticeAccess.load(tx, actor, practiceId);
    assertPracticeRole(ctx, required, action);
    return ctx;
  },

  /** True when `userId` is an ACTIVE member of the practice (checked on the colleague directory). */
  async isActiveMember(tx: UserScopeDb, practiceId: string, userId: string): Promise<boolean> {
    const [row] = await tx
      .select({ userId: practiceRoster.userId })
      .from(practiceRoster)
      .where(
        and(
          eq(practiceRoster.practiceId, practiceId),
          eq(practiceRoster.userId, userId),
          eq(practiceRoster.status, "ACTIVE"),
        ),
      );
    return Boolean(row);
  },
};
