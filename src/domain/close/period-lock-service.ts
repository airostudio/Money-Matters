import { and, desc, eq } from "drizzle-orm";
import { fiscalPeriods, periodCloses, periodLockEvents } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { Permission } from "@/domain/permissions/roles";
import { FiscalPeriodNotFoundError } from "@/domain/ledger/errors";
import {
  classifyLockChange,
  evaluateLockChange,
  isLockLevel,
  type LockLevel,
} from "@/domain/ledger/period-lock";
import { PeriodLockChangeError } from "./errors";
import { ensurePeriodRow, resolvePeriod, type FiscalPeriodRow } from "./period-resolution";
import type { PeriodRef } from "./period-ref";

/**
 * Closing, locking, reopening and signing off are permanently HUMAN-gated
 * critical actions (docs/ai-agents.md): even an actor carrying an OWNER role
 * is refused unless it is a human. Structural — there is no autonomy level
 * at which this passes — and in addition to the role check.
 */
export function assertHumanWith(actor: Actor, permission: Permission): void {
  assertPermission(actor, permission);
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError(permission, actor.role);
}

/** Locks the period row for the rest of the transaction, serialising concurrent close/reopen/lock changes on it. */
export async function lockPeriodRow(tx: TenantDb, organizationId: string, periodId: string): Promise<FiscalPeriodRow> {
  const [row] = await tx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.organizationId, organizationId)))
    .for("update");
  if (!row) throw new FiscalPeriodNotFoundError(periodId);
  return row;
}

export async function latestCycle(tx: TenantDb, organizationId: string, periodId: string) {
  const [row] = await tx
    .select()
    .from(periodCloses)
    .where(and(eq(periodCloses.organizationId, organizationId), eq(periodCloses.fiscalPeriodId, periodId)))
    .orderBy(desc(periodCloses.cycle))
    .limit(1);
  return row ?? null;
}

export async function startCycle(tx: TenantDb, actor: Actor, periodId: string, previousCycle: number) {
  const [row] = await tx
    .insert(periodCloses)
    .values({
      organizationId: actor.organizationId,
      fiscalPeriodId: periodId,
      cycle: previousCycle + 1,
      status: "IN_PROGRESS",
      startedById: actor.userId,
    })
    .returning();
  if (!row) throw new Error("Failed to start close cycle.");
  return row;
}

export interface ChangeLevelParams {
  to: LockLevel;
  reason?: string | null;
  acknowledgement?: string | null;
  /** Audit action name; defaults to period.locked / period.reopened / period.lock_lowered. */
  auditAction?: string;
  auditExtra?: Record<string, unknown>;
  periodCloseId?: string | null;
  eventReason?: string;
  eventMetadata?: Record<string, unknown>;
}

/**
 * THE one place a period's lock level changes. Validates through the pure
 * `evaluateLockChange` (permission by role, mandatory reason and TAX_LOCKED
 * acknowledgement for lowering), updates `fiscal_periods`, appends the
 * who/when/why/before/after row to the append-only `period_lock_events`, and
 * writes the org audit entry — all in the caller's transaction, so any failure
 * rolls the whole change back. It never touches a posted journal entry:
 * reopening lowers a lock, it does not edit history.
 */
export async function changeLockLevel(
  tx: TenantDb,
  actor: Actor,
  period: FiscalPeriodRow,
  params: ChangeLevelParams,
): Promise<FiscalPeriodRow> {
  const from = period.status as LockLevel;
  const decision = evaluateLockChange({
    from,
    to: params.to,
    role: actor.role,
    actorType: actor.type,
    reason: params.reason,
    acknowledgement: params.acknowledgement,
  });
  if (!decision.ok) {
    switch (decision.problem) {
      case "NO_CHANGE":
        throw PeriodLockChangeError.noChange(from);
      case "NOT_PERMITTED":
        throw new PermissionDeniedError(decision.requiredPermission!, actor.role);
      case "REASON_REQUIRED":
        throw PeriodLockChangeError.reasonRequired();
      case "TAX_ACKNOWLEDGEMENT_REQUIRED":
        throw PeriodLockChangeError.taxAcknowledgementRequired();
    }
  }

  const now = new Date();
  const reason = (params.reason ?? "").trim();
  const [updated] = await tx
    .update(fiscalPeriods)
    .set({
      status: params.to,
      lockedAt: params.to === "OPEN" ? null : now,
      lockedById: params.to === "OPEN" ? null : actor.userId,
      lockReason: params.to === "OPEN" ? null : reason || null,
      updatedAt: now,
    })
    .where(eq(fiscalPeriods.id, period.id))
    .returning();
  if (!updated) throw new FiscalPeriodNotFoundError(period.id);

  const eventType = decision.kind === "RAISE" ? "LOCKED" : params.to === "OPEN" ? "REOPENED" : "LEVEL_LOWERED";
  await tx.insert(periodLockEvents).values({
    organizationId: actor.organizationId,
    fiscalPeriodId: period.id,
    periodCloseId: params.periodCloseId ?? null,
    eventType,
    fromLevel: from,
    toLevel: params.to,
    reason: params.eventReason ?? (reason || (decision.kind === "RAISE" ? "Lock applied" : "Lock lowered")),
    acknowledgement: params.acknowledgement?.trim() || null,
    actorUserId: actor.userId,
    actorRole: actor.role,
    metadata: { periodLabel: period.label, ...(params.eventMetadata ?? {}) },
  });

  await AuditService.record(tx, actor, {
    action:
      params.auditAction ??
      (decision.kind === "RAISE" ? "period.locked" : params.to === "OPEN" ? "period.reopened" : "period.lock_lowered"),
    entityType: "FiscalPeriod",
    entityId: period.id,
    before: { status: from, periodLabel: period.label },
    after: { status: params.to, reason: reason || null, acknowledgement: params.acknowledgement?.trim() || null, ...(params.auditExtra ?? {}) },
  });

  return updated;
}

export const PeriodLockService = {
  /**
   * Raise the lock level of a period (more restrictive), e.g. SOFT -> HARD, or
   * TAX_LOCKED after a lodgement. Needs `period:close`. Does not run the close
   * checklist — that is what `PeriodCloseService.close` is for; this is the
   * direct lock used to tighten an already-closed period and by the legacy
   * `FiscalPeriodService.setStatus`.
   */
  async raise(actor: Actor, ref: PeriodRef | string, to: LockLevel, reason?: string): Promise<FiscalPeriodRow> {
    assertHumanWith(actor, "period:close");
    if (!isLockLevel(to) || to === "OPEN") throw new PeriodLockChangeError("INVALID_LEVEL", `"${to}" is not a lock level.`);
    return withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, ref);
      const ensured = await ensurePeriodRow(tx, actor, resolved);
      const row = await lockPeriodRow(tx, actor.organizationId, ensured.id);
      if (classifyLockChange(row.status as LockLevel, to) !== "RAISE") {
        throw new PeriodLockChangeError("NOT_A_RAISE", `The period is already ${row.status}; use reopen to lower a lock.`);
      }
      return changeLockLevel(tx, actor, row, { to, reason });
    });
  },

  /**
   * Reopen / lower the lock on a period — the audited override workflow
   * (master spec §41/§77). Needs `period:reopen` (or `period:reopen_hard` when
   * the period is TAX_LOCKED/HARD_LOCKED), a reason of at least 10 characters,
   * and — leaving TAX_LOCKED — a typed acknowledgement that it may invalidate a
   * lodgement. Records who/when/why and before/after in the append-only
   * `period_lock_events` AND the org `audit_logs`, and starts a fresh close
   * cycle so the earlier close stays as immutable history and sign-offs must be
   * redone. Posted entries are never altered.
   */
  async reopen(
    actor: Actor,
    ref: PeriodRef | string,
    input: { reason: string; toLevel?: LockLevel; acknowledgement?: string },
  ): Promise<{ period: FiscalPeriodRow; cycle: number }> {
    // Fail fast on role before any lookup (the precise permission is re-checked per level inside).
    assertHumanWith(actor, "period:reopen");
    const toLevel = input.toLevel ?? "OPEN";
    if (!isLockLevel(toLevel)) throw new PeriodLockChangeError("INVALID_LEVEL", `"${toLevel}" is not a lock level.`);
    return withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, ref);
      if (!resolved.id) {
        throw new PeriodLockChangeError("NOT_CLOSED", `Period ${resolved.label} has never been locked, so there is nothing to reopen.`);
      }
      const row = await lockPeriodRow(tx, actor.organizationId, resolved.id);
      if (classifyLockChange(row.status as LockLevel, toLevel) !== "LOWER") {
        throw new PeriodLockChangeError("NOT_A_LOWER", `Reopening must lower the lock; the period is ${row.status}.`);
      }
      const previous = await latestCycle(tx, actor.organizationId, row.id);
      // An IN_PROGRESS cycle (sign-offs in flight, never closed) simply continues; a CLOSED one is kept as history and a new cycle begins.
      const cycle = previous?.status === "IN_PROGRESS" ? previous : await startCycle(tx, actor, row.id, previous?.cycle ?? 0);
      const updated = await changeLockLevel(tx, actor, row, {
        to: toLevel,
        reason: input.reason,
        acknowledgement: input.acknowledgement,
        periodCloseId: cycle.id,
        auditExtra: { previousCycle: previous?.cycle ?? null, newCycle: cycle.cycle },
        eventMetadata: { previousCycle: previous?.cycle ?? null, newCycle: cycle.cycle },
      });
      return { period: updated, cycle: cycle.cycle };
    });
  },
};
