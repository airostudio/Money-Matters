import "server-only";
import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";

/**
 * Master spec §8's autonomy levels. Only 0-2 are implemented this slice —
 * see `docs/ai-agents.md` §3 for why Level 3 (auto-execute low-risk) and
 * Level 4 (finance automation) are deliberately NOT built: every mutating
 * action this codebase has today (posting an invoice, approving a payment
 * run, ...) is exactly the kind of thing master spec §8 itself calls out as
 * always requiring authorisation, and auto-executing any of it needs a
 * trust/audit track record this codebase does not have yet. Levels 0 and 1
 * are functionally identical today (both mean "the Controller may only
 * inform/suggest, never offer a write tool") — they're kept as distinct
 * values because master spec §8 names them distinctly, not because this
 * slice treats them differently.
 */
export const AUTONOMY_LEVELS = [0, 1, 2] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  0: "Level 0 — Manual (information only)",
  1: "Level 1 — Suggest (information only)",
  2: "Level 2 — Prepare (AI may draft invoices/bills/journal entries for human review)",
};

/** The level every organization starts at — an explicit opt-in is required to reach Level 2. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 0;

export class InvalidAutonomyLevelError extends Error {
  constructor(level: number) {
    super(
      `Autonomy level ${level} is not available. Only Levels 0-2 are implemented — Level 3 (auto-execute low-risk) ` +
        "and Level 4 (finance automation) require a trust/audit track record this codebase does not have yet (see docs/ai-agents.md §3).",
    );
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

  /** OWNER/ADMINISTRATOR-only, per the task's "Level 2 must be an explicit opt-in by an OWNER/ADMINISTRATOR, not a default." */
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
};
