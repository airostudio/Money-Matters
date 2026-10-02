import "server-only";
import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";

/**
 * Master spec §8's full five autonomy levels, as of Phase 6 Slice 3.
 *
 * - **0 (Manual) / 1 (Suggest)** — functionally identical: inform/suggest
 *   only, exactly like Slice 1's only possible behavior.
 * - **2 (Prepare)** — offers `prepare_draft_invoice`/`prepare_draft_bill`/
 *   `prepare_draft_journal_entry`; every proposal still waits on a separate,
 *   explicit human confirmation click (Slice 2 — see `write-tools.ts`,
 *   `draft-proposal-service.ts`).
 * - **3 (Auto, low-risk) / 4 (Finance automation)** — the AI may
 *   auto-EXECUTE (not just prepare) a narrow, explicitly organization-
 *   whitelisted set of action types, with NO per-instance confirmation click
 *   — see `auto-execution-policy.ts`/`auto-execution-service.ts`. Selecting
 *   Level 3 or 4 here does NOTHING by itself: the level is necessary but not
 *   sufficient. An org must ALSO explicitly whitelist each individual action
 *   type it wants auto-executed (master spec §76's "learn ... only through
 *   controlled configuration," never implied by the level number alone —
 *   see `AutoApprovedActionsService` and
 *   `src/tests/unit/ai-controller/auto-execution-policy.test.ts`). Levels 3
 *   and 4 share the identical whitelist mechanism and, today, the identical
 *   closed set of auto-approvable action types — see docs/ai-agents.md §3b
 *   for the honest explanation of why this codebase does not yet have a
 *   second, broader-but-still-safe action type to reserve for Level 4 alone,
 *   and what would change that. A hard-excluded category (supplier
 *   payments/payment runs, bank account detail changes, payroll, tax,
 *   unusual journal entries, fiscal period closes) is enforced structurally
 *   at EVERY level, including 3 and 4 — never offered as an auto-approvable
 *   action type at all, not merely refused in the UI.
 */
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  0: "Level 0 — Manual (information only)",
  1: "Level 1 — Suggest (information only)",
  2: "Level 2 — Prepare (AI may draft invoices/bills/journal entries for human review)",
  3: "Level 3 — Auto, low risk (AI may auto-execute specific, explicitly whitelisted repetitive actions)",
  4: "Level 4 — Finance automation (broader set of explicitly whitelisted actions; high-risk actions always still require authorisation)",
};

/** A longer, plain-English explanation per level for the settings UI — "don't make the user guess" what a level actually does. */
export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  0: "The AI Financial Controller can only answer questions about your real records. It never drafts, creates, or changes anything.",
  1: "Same as Level 0 today — the AI may suggest, but still never drafts, creates, or changes anything.",
  2: "The AI may prepare a DRAFT invoice, bill, or journal entry when you ask — but it always waits for you to review and explicitly click \"Create this draft\" before anything is created. Nothing happens automatically.",
  3: "The AI may automatically carry out a small, specific list of actions WITHOUT asking you first — but only the action types you explicitly turn on below. Turning this level on by itself changes nothing until you also whitelist at least one action type.",
  4: "The same automatic-execution mechanism as Level 3, with the whitelist able to cover a broader set of action types as more become available. High-risk actions (payments, bank details, payroll, tax, unusual journals, closing a period) are never offered here, at any level.",
};

/** The level every organization starts at — an explicit opt-in is required to reach anything higher. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 0;

export class InvalidAutonomyLevelError extends Error {
  constructor(level: number) {
    super(`Autonomy level ${level} is not a valid level — only 0-4 are defined (see master spec §8).`);
    this.name = "InvalidAutonomyLevelError";
  }
}

function isAutonomyLevel(value: number): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly number[]).includes(value);
}

/**
 * Org-level autonomy setting (master spec §8), gating which Controller
 * tools are even offered to the model — see `write-tools.ts` and
 * `financial-controller-service.ts`. This is checked BEFORE the model ever
 * sees a write tool exists, not only when it tries to call one, per
 * docs/ai-agents.md's "the gate is on tool-list construction, not just on
 * execution" discipline carried over from Slice 1's permission checks.
 */
export const AutonomySettingsService = {
  /**
   * No permission check: every member needs to know the organization's
   * current autonomy level to render the Controller's own UI correctly
   * (e.g. whether to mention drafting at all), and the number itself is not
   * sensitive. The actual gate this protects is enforced structurally by
   * which tools get built, not by hiding this value.
   */
  async getLevel(organizationId: string): Promise<AutonomyLevel> {
    return withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select({ aiAutonomyLevel: organizations.aiAutonomyLevel })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      const level = row?.aiAutonomyLevel ?? DEFAULT_AUTONOMY_LEVEL;
      return isAutonomyLevel(level) ? level : DEFAULT_AUTONOMY_LEVEL;
    });
  },

  /** OWNER/ADMINISTRATOR-only, per the task's "reaching a higher level must be an explicit opt-in by an OWNER/ADMINISTRATOR, not a default." */
  async setLevel(actor: Actor, level: number): Promise<AutonomyLevel> {
    assertPermission(actor, "organization:manage");
    if (!isAutonomyLevel(level)) {
      throw new InvalidAutonomyLevelError(level);
    }

    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select({ aiAutonomyLevel: organizations.aiAutonomyLevel })
        .from(organizations)
        .where(eq(organizations.id, actor.organizationId));

      await tx
        .update(organizations)
        .set({ aiAutonomyLevel: level, updatedAt: new Date() })
        .where(eq(organizations.id, actor.organizationId));

      await AuditService.record(tx, actor, {
        action: "ai_controller.autonomy_level_changed",
        entityType: "Organization",
        entityId: actor.organizationId,
        before: { aiAutonomyLevel: existing?.aiAutonomyLevel ?? DEFAULT_AUTONOMY_LEVEL },
        after: { aiAutonomyLevel: level },
      });

      return level;
    });
  },

  /**
   * Master spec §77's "pause/override" — a real, reachable "stop everything
   * now" control, deliberately separate from the normal level-picker form so
   * it's never mistaken for just another settings change. It is NOT a
   * special code path: it calls `setLevel(actor, 0)` (the exact same write
   * `getLevel`/`isApproved` read fresh on their very next call — there is no
   * cache to invalidate, see this module's doc comment and
   * `auto-execution-policy.ts`), so its effect is immediate by construction,
   * not by any explicit invalidation step. The whitelist itself (which
   * action types are enabled) is left untouched — dropping to Level 0 alone
   * already makes `isApproved` return false for everything, and preserving
   * the whitelist means re-enabling Level 3/4 later restores the same
   * configuration rather than silently wiping it.
   */
  async emergencyStop(actor: Actor): Promise<AutonomyLevel> {
    assertPermission(actor, "organization:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select({ aiAutonomyLevel: organizations.aiAutonomyLevel })
        .from(organizations)
        .where(eq(organizations.id, actor.organizationId));

      await tx
        .update(organizations)
        .set({ aiAutonomyLevel: 0, updatedAt: new Date() })
        .where(eq(organizations.id, actor.organizationId));

      await AuditService.record(tx, actor, {
        action: "ai_controller.emergency_stop",
        entityType: "Organization",
        entityId: actor.organizationId,
        before: { aiAutonomyLevel: existing?.aiAutonomyLevel ?? DEFAULT_AUTONOMY_LEVEL },
        after: { aiAutonomyLevel: 0 },
        metadata: { reason: "emergency_stop" },
      });

      return 0 as AutonomyLevel;
    });
  },
};
