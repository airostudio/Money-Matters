import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aiAutoApprovedActions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AutonomySettingsService } from "./autonomy";

/**
 * Phase 6 Slice 3's whitelist mechanism (master spec §76: "learn
 * organisation-specific patterns only through controlled configuration").
 *
 * `AUTO_APPROVABLE_ACTION_TYPES` is the entire, closed set of action types an
 * organization may ever whitelist for auto-execution at autonomy Level 3/4 —
 * see `src/db/schema.ts`'s `aiAutoExecutionActionTypeEnum` doc comment for
 * why each one is safe (an existing, already-human-triggered mechanism,
 * trivially reversible) and docs/ai-agents.md §3b for the full design.
 *
 * This list is enforced in TWO places, not just one: the Postgres enum
 * column (so a raw SQL write can't smuggle in a bogus value) AND this
 * module's zod schema (so a caller inside the application can't either,
 * before anything reaches the database). Nothing resembling a supplier
 * payment, a bank account detail, payroll, tax, an "unusual" journal entry,
 * or a fiscal period close appears here, at Level 3 OR Level 4 — see
 * `EXCLUDED_ACTION_TYPE_EXAMPLES` below and
 * `src/tests/unit/ai-controller/auto-execution-policy.test.ts`, which proves
 * the two sets are disjoint and that attempting to whitelist an excluded
 * example string is refused structurally, not merely absent from a UI list.
 */
export const AUTO_APPROVABLE_ACTION_TYPES = [
  "RECURRING_INVOICE_AUTO_GENERATE",
  "RECURRING_BILL_AUTO_GENERATE",
  "BANK_RECONCILIATION_AUTO_MATCH",
] as const;

export type AutoApprovedActionType = (typeof AUTO_APPROVABLE_ACTION_TYPES)[number];

const AutoApprovedActionTypeSchema = z.enum(AUTO_APPROVABLE_ACTION_TYPES);

export function isAutoApprovableActionType(value: string): value is AutoApprovedActionType {
  return (AUTO_APPROVABLE_ACTION_TYPES as readonly string[]).includes(value);
}

export const AUTO_APPROVED_ACTION_LABELS: Record<AutoApprovedActionType, string> = {
  RECURRING_INVOICE_AUTO_GENERATE:
    "Auto-generate due recurring customer invoices (the same DRAFT a human would click \"Generate due invoices\" to create)",
  RECURRING_BILL_AUTO_GENERATE:
    "Auto-generate due recurring supplier bills (the same DRAFT a human would click \"Generate due bills\" to create)",
  BANK_RECONCILIATION_AUTO_MATCH:
    "Auto-confirm a bank transaction match ONLY when it is a same-day, exact-amount match against an existing posted journal line — never a lower-confidence or AI-scored fuzzy suggestion",
};

/**
 * Documented, never-whitelistable examples — purely for tests and for the
 * settings UI's "what this will never do" copy. These are never read by any
 * gating check (gating only ever consults the closed
 * `AUTO_APPROVABLE_ACTION_TYPES` allowlist above, structurally — there is no
 * code path that evaluates this list at runtime), so this constant cannot
 * itself be the thing standing between an excluded action and auto-execution;
 * it exists so the exclusion is written down in one place tests can assert
 * against, rather than only being true by omission.
 */
export const EXCLUDED_ACTION_TYPE_EXAMPLES = [
  "SUPPLIER_PAYMENT_CREATE",
  "SUPPLIER_PAYMENT_APPROVE",
  "PAYMENT_RUN_CREATE",
  "PAYMENT_RUN_APPROVE",
  "BANK_ACCOUNT_DETAIL_CHANGE",
  "PAYROLL_ANY",
  "TAX_SUBMISSION_ANY",
  "JOURNAL_ENTRY_UNUSUAL",
  "FISCAL_PERIOD_CLOSE",
] as const;

export class InvalidAutoApprovedActionTypeError extends Error {
  constructor(value: string) {
    super(
      `"${value}" is not an auto-approvable action type. Only ${AUTO_APPROVABLE_ACTION_TYPES.join(", ")} may ever be whitelisted for auto-execution (see docs/ai-agents.md §3b) — this is enforced structurally, not just left off a settings page.`,
    );
    this.name = "InvalidAutoApprovedActionTypeError";
  }
}

export interface AutoApprovedActionRow {
  actionType: AutoApprovedActionType;
  enabledByUserId: string;
  createdAt: string;
}

/**
 * The per-org whitelist itself. Reaching autonomy Level 3/4 alone never adds
 * a row here — see `autonomy.ts`'s doc comment — so a freshly-created
 * organization, or one that just raised its level, auto-executes nothing
 * until an OWNER/ADMINISTRATOR explicitly enables at least one action type
 * here, one at a time, exactly like `AutonomySettingsService.setLevel`
 * itself requires `organization:manage`.
 */
export const AutoApprovedActionsService = {
  /** No permission check — same rationale as `AutonomySettingsService.getLevel`: every member needs to see the current whitelist to understand what the Controller might do, and the list itself is not sensitive. */
  async list(organizationId: string): Promise<AutoApprovedActionRow[]> {
    return withTenant(organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(aiAutoApprovedActions)
        .where(eq(aiAutoApprovedActions.organizationId, organizationId));
      return rows.map((r) => ({
        actionType: r.actionType,
        enabledByUserId: r.enabledByUserId,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  },

  /**
   * OWNER/ADMINISTRATOR-only. `actionType` is validated against the closed
   * zod enum regardless of what TypeScript's own type already restricts the
   * caller to — this is the structural, runtime half of the "never just a
   * UI dropdown" guarantee: even a caller that bypasses the type system
   * (e.g. a raw string from a form, or a test deliberately trying an
   * excluded value) is refused here, before any database write.
   */
  async setEnabled(actor: Actor, actionType: string, enabled: boolean): Promise<void> {
    assertPermission(actor, "organization:manage");
    const parsed = AutoApprovedActionTypeSchema.safeParse(actionType);
    if (!parsed.success) {
      throw new InvalidAutoApprovedActionTypeError(actionType);
    }
    const type = parsed.data;

    await withTenant(actor.organizationId, async (tx) => {
      if (enabled) {
        const [existing] = await tx
          .select({ id: aiAutoApprovedActions.id })
          .from(aiAutoApprovedActions)
          .where(and(eq(aiAutoApprovedActions.organizationId, actor.organizationId), eq(aiAutoApprovedActions.actionType, type)));
        if (existing) return; // Already whitelisted — idempotent.

        await tx.insert(aiAutoApprovedActions).values({
          organizationId: actor.organizationId,
          actionType: type,
          enabledByUserId: actor.userId,
        });

        await AuditService.record(tx, actor, {
          action: "ai_controller.auto_approved_action_enabled",
          entityType: "AIAutoApprovedAction",
          entityId: type,
          after: { actionType: type, enabledByUserId: actor.userId },
        });
      } else {
        await tx
          .delete(aiAutoApprovedActions)
          .where(and(eq(aiAutoApprovedActions.organizationId, actor.organizationId), eq(aiAutoApprovedActions.actionType, type)));

        await AuditService.record(tx, actor, {
          action: "ai_controller.auto_approved_action_disabled",
          entityType: "AIAutoApprovedAction",
          entityId: type,
          before: { actionType: type },
        });
      }
    });
  },
};

/**
 * THE gate every auto-execution attempt must pass, re-checked fresh every
 * single time — never cached across a session, a request, or even within
 * one `AutoExecutionService.runPendingAutoExecutions` call's multiple action
 * types. This is what makes the emergency stop (`AutonomySettingsService.
 * emergencyStop`) take effect immediately: the very next call to this
 * function after the level is dropped reads the current row from Postgres
 * and returns false, with nothing anywhere holding on to the old level. Both
 * conditions are required — the level AND an explicit whitelist row — so
 * neither one alone ever triggers auto-execution (see this module's and
 * `autonomy.ts`'s doc comments, and the "level alone does nothing" test).
 */
export async function isAutoExecutionApproved(
  organizationId: string,
  actionType: AutoApprovedActionType,
): Promise<{ approved: boolean; level: number; archived?: boolean }> {
  // The archived flag rides in the SAME query as the level (no extra round trip). An archived organization is never
  // approved, whatever its stored level/whitelist - and they are left untouched for a later restore.
  const { level, archived } = await AutonomySettingsService.getLevelAndArchived(organizationId);
  if (archived) return { approved: false, level, archived: true };
  if (level < 3) return { approved: false, level };

  const approved = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ id: aiAutoApprovedActions.id })
      .from(aiAutoApprovedActions)
      .where(and(eq(aiAutoApprovedActions.organizationId, organizationId), eq(aiAutoApprovedActions.actionType, actionType)));
    return Boolean(row);
  });

  return { approved, level };
}
