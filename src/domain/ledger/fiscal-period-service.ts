import { and, asc, eq } from "drizzle-orm";
import { fiscalPeriods } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";

export class FiscalPeriodNotFoundError extends Error {
  constructor(periodId: string) {
    super(`Fiscal period ${periodId} was not found in this organization.`);
    this.name = "FiscalPeriodNotFoundError";
  }
}

export interface CreateFiscalPeriodInput {
  label: string;
  startDate: Date;
  endDate: Date;
}

export const FiscalPeriodService = {
  async list(actor: Actor) {
    assertPermission(actor, "journal:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(fiscalPeriods)
        .where(eq(fiscalPeriods.organizationId, actor.organizationId))
        .orderBy(asc(fiscalPeriods.startDate)),
    );
  },

  async create(actor: Actor, input: CreateFiscalPeriodInput) {
    assertPermission(actor, "fiscal_period:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [period] = await tx
        .insert(fiscalPeriods)
        .values({
          organizationId: actor.organizationId,
          label: input.label,
          startDate: input.startDate,
          endDate: input.endDate,
        })
        .returning();
      if (!period) throw new Error("Failed to create fiscal period.");

      await AuditService.record(tx, actor, {
        action: "fiscal_period.created",
        entityType: "FiscalPeriod",
        entityId: period.id,
        after: period,
      });

      return period;
    });
  },

  /**
   * Soft/hard lock a period, or reopen it. Reopening a HARD_LOCKED period is
   * intentionally the same permission as locking it in Phase 1 — the
   * dedicated "request override / approve override" workflow (master spec
   * §41) lands in Phase 9; today it's an authorized reject-or-allow, always
   * audited with the actor and reason.
   */
  async setStatus(
    actor: Actor,
    periodId: string,
    status: "OPEN" | "SOFT_LOCKED" | "HARD_LOCKED",
    reason?: string,
  ) {
    assertPermission(actor, "fiscal_period:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(fiscalPeriods)
        .where(
          and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.organizationId, actor.organizationId)),
        );
      if (!existing) throw new FiscalPeriodNotFoundError(periodId);

      const [updated] = await tx
        .update(fiscalPeriods)
        .set({
          status,
          lockedAt: status === "OPEN" ? null : new Date(),
          lockedById: status === "OPEN" ? null : actor.userId,
          lockReason: status === "OPEN" ? null : (reason ?? null),
          updatedAt: new Date(),
        })
        .where(eq(fiscalPeriods.id, periodId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "fiscal_period.status_changed",
        entityType: "FiscalPeriod",
        entityId: periodId,
        before: { status: existing.status },
        after: { status, reason },
      });

      return updated;
    });
  },
};
