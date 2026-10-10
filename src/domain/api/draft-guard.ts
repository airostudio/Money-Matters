import type { TenantDb } from "@/db/tenant";
import { PeriodLockedError } from "@/domain/ledger/errors";
import { evaluatePosting, type LockLevel } from "@/domain/ledger/period-lock";
import { findFiscalPeriod } from "@/domain/ledger/posting-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * An integration may not pile DRAFT documents into a period a person has locked.
 *
 * The UI lets a human start a draft in any period (the lock bites when they POST it, and an authorised human can
 * override a soft lock with a reason). An API key is never human, so no override exists for it: this reuses the
 * posting engine's own decision function (`evaluatePosting` with actor type `API`) against the period governing
 * the document's date, which allows only an OPEN period - SOFT / ADVISOR / TAX / HARD locked all refuse. It runs
 * inside the same transaction as the create, so a refusal leaves nothing behind (typed `PeriodLockedError` -> 409
 * `period_locked`, carrying the lock level).
 */
export async function assertDateOpenForApiDraft(tx: TenantDb, actor: Actor, documentDate: Date): Promise<void> {
  const period = await findFiscalPeriod(tx, actor.organizationId, documentDate);
  if (!period) return;
  const level = period.status as LockLevel;
  const decision = evaluatePosting({ level, role: actor.role, actorType: actor.type });
  if (!decision.allowed) {
    throw new PeriodLockedError(period.label, {
      lockLevel: level,
      denialCode: decision.code,
      canOverrideWithReason: false,
    });
  }
}
