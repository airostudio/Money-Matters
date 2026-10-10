import { and, asc, eq } from "drizzle-orm";
import { fiscalPeriods } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { FiscalPeriodNotFoundError } from "@/domain/ledger/errors";
import type { LockLevel } from "@/domain/ledger/period-lock";
import { isCalendarMonth, monthBounds, monthKey, monthKeyOf, parsePeriodRef, type PeriodRef } from "./period-ref";

export type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

export interface ResolvedPeriod {
  /** Null when the period exists only implicitly (a calendar month with no `fiscal_periods` row yet). */
  id: string | null;
  /** YYYY-MM for a calendar month, otherwise the fiscal period id. */
  key: string;
  label: string;
  start: Date;
  end: Date;
  /** The period's OWN lock level (OPEN when implicit). */
  lockLevel: LockLevel;
  row: FiscalPeriodRow | null;
}

function fromRow(row: FiscalPeriodRow): ResolvedPeriod {
  return {
    id: row.id,
    key: isCalendarMonth(row.startDate, row.endDate) ? monthKeyOf(row.startDate) : row.id,
    label: row.label,
    start: row.startDate,
    end: row.endDate,
    lockLevel: row.status as LockLevel,
    row,
  };
}

/**
 * Resolves a period reference to a period WITHOUT creating anything. A
 * calendar-month reference that matches no `fiscal_periods` row resolves to
 * an implicit, OPEN period (`id: null`) — periods are created explicitly (or,
 * for the close workspace, on the first mutation via `ensurePeriodRow`), never
 * lazily by a posting.
 */
export async function resolvePeriod(
  tx: TenantDb,
  organizationId: string,
  ref: PeriodRef | string,
): Promise<ResolvedPeriod> {
  const parsed = typeof ref === "string" ? parsePeriodRef(ref) : ref;
  if (parsed.kind === "id") {
    const [row] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.id, parsed.id), eq(fiscalPeriods.organizationId, organizationId)));
    if (!row) throw new FiscalPeriodNotFoundError(parsed.id);
    return fromRow(row);
  }

  const key = monthKey(parsed.year, parsed.month);
  const { start, end } = monthBounds(parsed.year, parsed.month);
  const rows = await tx
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.organizationId, organizationId))
    .orderBy(asc(fiscalPeriods.createdAt));
  const match =
    rows.find((r) => r.label === key) ??
    rows.find((r) => r.startDate.getTime() === start.getTime() && r.endDate.getTime() === end.getTime());
  if (match) return fromRow(match);
  return { id: null, key, label: key, start, end, lockLevel: "OPEN", row: null };
}

/** Materialises an implicit month as a `fiscal_periods` row (audited like any period creation). */
export async function ensurePeriodRow(tx: TenantDb, actor: Actor, period: ResolvedPeriod): Promise<FiscalPeriodRow> {
  if (period.row) return period.row;
  const [created] = await tx
    .insert(fiscalPeriods)
    .values({
      organizationId: actor.organizationId,
      label: period.label,
      startDate: period.start,
      endDate: period.end,
    })
    .returning();
  if (!created) throw new Error("Failed to create fiscal period.");
  await AuditService.record(tx, actor, {
    action: "fiscal_period.created",
    entityType: "FiscalPeriod",
    entityId: created.id,
    after: created,
    metadata: { source: "month_close_workspace" },
  });
  return created;
}
