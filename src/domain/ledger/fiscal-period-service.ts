import { and, asc, eq } from "drizzle-orm";
import { fiscalPeriods } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { FiscalPeriodNotFoundError } from "./errors";
import { classifyLockChange, type LockLevel } from "./period-lock";
import { PeriodLockService } from "@/domain/close/period-lock-service";

export { FiscalPeriodNotFoundError };

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
   * Legacy single-call lock/unlock, kept for compatibility (the seed script
   * and existing callers), now routed through the Phase 9 Slice 3 lock model
   * so it can no longer be used to sidestep it: RAISING a lock goes through
   * `PeriodLockService.raise` (needs `period:close`); LOWERING one is a
   * reopen and goes through `PeriodLockService.reopen` — it needs
   * `period:reopen` (or `period:reopen_hard` for a TAX/HARD lock) and a
   * reason of at least 10 characters. Always audited, always appended to the
   * period's append-only lock history. The month-end close workspace
   * (`PeriodCloseService`) is the primary UI path; this remains the
   * programmatic one.
   */
  async setStatus(actor: Actor, periodId: string, status: LockLevel, reason?: string) {
    assertPermission(actor, "fiscal_period:manage");
    const [existing] = await withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(fiscalPeriods)
        .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.organizationId, actor.organizationId))),
    );
    if (!existing) throw new FiscalPeriodNotFoundError(periodId);

    const kind = classifyLockChange(existing.status as LockLevel, status);
    if (kind === "NO_CHANGE") return existing;
    if (kind === "RAISE") return PeriodLockService.raise(actor, { kind: "id", id: periodId }, status, reason);
    const { period } = await PeriodLockService.reopen(actor, { kind: "id", id: periodId }, { reason: reason ?? "", toLevel: status });
    return period;
  },
};
