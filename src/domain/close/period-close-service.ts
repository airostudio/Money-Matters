import { and, asc, desc, eq, inArray, min, ne, sql } from "drizzle-orm";
import { closeSignoffs, fiscalPeriods, journalEntries, periodCloses, periodLockEvents, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import {
  CLOSE_LOCK_LEVELS,
  LOCK_RANK,
  isLockLevel,
  isLocked,
  mostRestrictive,
  type LockLevel,
} from "@/domain/ledger/period-lock";
import { CloseAcknowledgementRequiredError, CloseBlockedError, CloseChecklistHiddenError, PeriodLockChangeError, SignoffError } from "./errors";
import { CloseChecklistService } from "./checklist-service";
import { MANUAL_CHECKS } from "./checklist-items";
import type { PeriodChecklist } from "./checklist-types";
import { assertHumanWith, changeLockLevel, latestCycle, lockPeriodRow, startCycle } from "./period-lock-service";
import { isCalendarMonth, monthBounds, monthKey, monthKeyOf, parsePeriodRef, previousMonth, type PeriodRef } from "./period-ref";
import { ensurePeriodRow, resolvePeriod, type FiscalPeriodRow } from "./period-resolution";

/** Sign-off is not meaningful for intercompany (always not-applicable: single-entity organizations). */
const SIGNABLE_KEYS = new Set(MANUAL_CHECKS.filter((c) => c.key !== "manual.intercompany").map((c) => c.key));

/** Default lock applied by a month-end close: SOFT_LOCKED. See docs/accounting-engine.md for why. */
export const DEFAULT_CLOSE_LOCK_LEVEL: LockLevel = "SOFT_LOCKED";

export interface ClosePeriodInput {
  lockLevel?: LockLevel;
  /** The explicit acknowledgement that outstanding (attention / unsigned manual) items remain. */
  acknowledgeOutstanding?: boolean;
  note?: string;
}

export interface PeriodListItem {
  key: string;
  label: string;
  start: string;
  end: string;
  kind: "MONTH" | "RANGE";
  fiscalPeriodId: string | null;
  ownLevel: LockLevel;
  /** The most restrictive level of any period overlapping this one. */
  effectiveLevel: LockLevel;
  coveredBy: Array<{ key: string; label: string; level: LockLevel }>;
  closeStatus: "NOT_STARTED" | "IN_PROGRESS" | "CLOSED";
  cycle: number | null;
  closedAt: string | null;
  closedByName: string | null;
  lockLevelApplied: LockLevel | null;
  /** The percent computed live at close time, from the stored snapshot — never presented as current. */
  percentAtClose: number | null;
  signoffsDone: number;
  signoffsTotal: number;
  /** Live percent: computed only for the single "focus" period, to keep the list cheap. */
  livePercent: number | null;
}

export interface LockEventView {
  id: string;
  eventType: string;
  fromLevel: LockLevel;
  toLevel: LockLevel;
  reason: string;
  acknowledgement: string | null;
  actorName: string | null;
  actorRole: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

export interface CloseCycleView {
  id: string;
  cycle: number;
  status: "NOT_STARTED" | "IN_PROGRESS" | "CLOSED";
  startedAt: string;
  closedAt: string | null;
  closedByName: string | null;
  lockLevelApplied: LockLevel | null;
  acknowledgedAttentionCount: number;
  percentAtClose: number | null;
}

export interface PeriodWorkspace {
  checklist: PeriodChecklist;
  cycles: CloseCycleView[];
  events: LockEventView[];
  /** Other, overlapping periods that carry a lock of their own (e.g. a locked financial year). */
  coveredBy: Array<{ key: string; label: string; level: LockLevel }>;
}

async function userNames(tx: Parameters<Parameters<typeof withTenant>[1]>[0], ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function percentFromSnapshot(snapshot: unknown): number | null {
  const p = (snapshot as { progress?: { percent?: number } } | null)?.progress?.percent;
  return typeof p === "number" ? p : null;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}

function rowKey(row: FiscalPeriodRow): string {
  return isCalendarMonth(row.startDate, row.endDate) ? monthKeyOf(row.startDate) : row.id;
}

export const PeriodCloseService = {
  /**
   * Close a period: runs the live checklist, refuses with a typed error listing
   * every BLOCKING item, requires an explicit acknowledgement when outstanding
   * (ATTENTION / unsigned manual) items remain, then — in one transaction —
   * locks the period at the chosen level, completes the close cycle with the
   * checklist SNAPSHOT, appends the lock event and writes the audit entry.
   *
   * The checklist is computed immediately before the closing transaction (its
   * own queries need their own sequential connections — see
   * `CloseChecklistService`), so the snapshot is the state at close time within
   * milliseconds; the lock itself is taken under a row lock.
   */
  async close(actor: Actor, ref: PeriodRef | string, input: ClosePeriodInput = {}) {
    assertHumanWith(actor, "period:close");
    const lockLevel = input.lockLevel ?? DEFAULT_CLOSE_LOCK_LEVEL;
    if (!isLockLevel(lockLevel) || !CLOSE_LOCK_LEVELS.includes(lockLevel)) {
      throw new PeriodLockChangeError("INVALID_LEVEL", `"${lockLevel}" is not a lock level a close can apply.`);
    }

    const checklist = await CloseChecklistService.compute(actor, ref);
    if (checklist.hiddenCount > 0) throw new CloseChecklistHiddenError(checklist.hiddenCount);
    if (checklist.blocking.length > 0) throw new CloseBlockedError(checklist.blocking);
    if (checklist.outstanding.length > 0 && !input.acknowledgeOutstanding) {
      throw new CloseAcknowledgementRequiredError(checklist.outstanding);
    }

    return withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, ref);
      const ensured = await ensurePeriodRow(tx, actor, resolved);
      const row = await lockPeriodRow(tx, actor.organizationId, ensured.id);
      if (LOCK_RANK[row.status as LockLevel] >= LOCK_RANK[lockLevel]) {
        throw new PeriodLockChangeError(
          "ALREADY_CLOSED",
          `Period ${row.label} is already ${row.status}. To tighten it use a higher lock level; to change it, reopen it first.`,
        );
      }

      let cycle = await latestCycle(tx, actor.organizationId, row.id);
      if (!cycle || cycle.status === "CLOSED") cycle = await startCycle(tx, actor, row.id, cycle?.cycle ?? 0);

      const now = new Date();
      const outstandingIds = checklist.outstanding.map((i) => i.id);
      const [closed] = await tx
        .update(periodCloses)
        .set({
          status: "CLOSED",
          closedAt: now,
          closedById: actor.userId,
          lockLevelApplied: lockLevel,
          acknowledgedAttentionCount: input.acknowledgeOutstanding ? checklist.outstanding.length : 0,
          checklistSnapshot: checklist,
        })
        .where(eq(periodCloses.id, cycle.id))
        .returning();
      if (!closed) throw new Error("Failed to complete the close cycle.");

      const outstandingNote = checklist.outstanding.length
        ? `closed with ${checklist.outstanding.length} outstanding item(s) acknowledged`
        : "closed with no outstanding items";
      const updated = await changeLockLevel(tx, actor, row, {
        to: lockLevel,
        reason: input.note?.trim() || `Month-end close (${outstandingNote}).`,
        periodCloseId: closed.id,
        auditAction: "period.closed",
        auditExtra: {
          cycle: closed.cycle,
          percentComplete: checklist.progress.percent,
          outstandingAcknowledged: input.acknowledgeOutstanding ? outstandingIds : [],
          summary: `Period ${row.label} ${outstandingNote} by ${actor.userId}`,
          checklistSnapshot: checklist,
        },
        eventMetadata: { cycle: closed.cycle, percentComplete: checklist.progress.percent, outstandingAcknowledged: input.acknowledgeOutstanding ? outstandingIds : [] },
      });
      return { period: updated, close: closed, checklist };
    });
  },

  /** Record a named human's sign-off on a MANUAL checklist item for the period's current cycle. */
  async signOff(actor: Actor, ref: PeriodRef | string, checkKey: string, note?: string) {
    assertHumanWith(actor, "close_checklist:manage");
    if (!SIGNABLE_KEYS.has(checkKey)) {
      throw new SignoffError("UNKNOWN_CHECK", `"${checkKey}" is not a manual checklist item that can be signed off.`);
    }
    return withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, ref);
      const ensured = await ensurePeriodRow(tx, actor, resolved);
      const row = await lockPeriodRow(tx, actor.organizationId, ensured.id);
      if (isLocked(row.status as LockLevel)) {
        throw new SignoffError("PERIOD_CLOSED", `Period ${row.label} is locked; reopen it before changing sign-offs.`);
      }
      let cycle = await latestCycle(tx, actor.organizationId, row.id);
      if (!cycle || cycle.status === "CLOSED") cycle = await startCycle(tx, actor, row.id, cycle?.cycle ?? 0);

      const [existing] = await tx
        .select({ id: closeSignoffs.id })
        .from(closeSignoffs)
        .where(and(eq(closeSignoffs.periodCloseId, cycle.id), eq(closeSignoffs.checkKey, checkKey)));
      if (existing) throw new SignoffError("ALREADY_SIGNED_OFF", "This item has already been signed off for this cycle.");

      const names = await userNames(tx, [actor.userId]);
      const [signoff] = await tx
        .insert(closeSignoffs)
        .values({
          organizationId: actor.organizationId,
          periodCloseId: cycle.id,
          checkKey,
          signedById: actor.userId,
          signedByName: names.get(actor.userId) ?? null,
          note: note?.trim() || null,
        })
        .returning();
      if (!signoff) throw new Error("Failed to record sign-off.");

      await AuditService.record(tx, actor, {
        action: "close.signed_off",
        entityType: "FiscalPeriod",
        entityId: row.id,
        after: { checkKey, note: signoff.note, cycle: cycle.cycle, periodLabel: row.label },
      });
      return signoff;
    });
  },

  async revokeSignOff(actor: Actor, ref: PeriodRef | string, checkKey: string) {
    assertHumanWith(actor, "close_checklist:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, ref);
      if (!resolved.id) throw new SignoffError("NOT_SIGNED_OFF", "Nothing has been signed off for this period.");
      const row = await lockPeriodRow(tx, actor.organizationId, resolved.id);
      if (isLocked(row.status as LockLevel)) {
        throw new SignoffError("PERIOD_CLOSED", `Period ${row.label} is locked; reopen it before changing sign-offs.`);
      }
      const cycle = await latestCycle(tx, actor.organizationId, row.id);
      const [existing] = cycle
        ? await tx
            .select()
            .from(closeSignoffs)
            .where(and(eq(closeSignoffs.periodCloseId, cycle.id), eq(closeSignoffs.checkKey, checkKey)))
        : [];
      if (!existing) throw new SignoffError("NOT_SIGNED_OFF", "This item has not been signed off.");
      await tx.delete(closeSignoffs).where(eq(closeSignoffs.id, existing.id));
      await AuditService.record(tx, actor, {
        action: "close.signoff_revoked",
        entityType: "FiscalPeriod",
        entityId: row.id,
        before: { checkKey, signedById: existing.signedById, signedAt: existing.signedAt, note: existing.note },
      });
    });
  },

  /**
   * The close workspace's periods: every calendar month from the first posted
   * activity (max 24 back) to the current month — including months that exist
   * only implicitly — plus any non-month fiscal period (e.g. a financial year).
   * Cheap by design: one transaction of plain queries. Live progress is
   * computed for the single "focus" period only (the previous month, if
   * unlocked); every other row shows its lock state, sign-off count, and — for
   * closed periods — the percent stored in its close snapshot.
   */
  async listPeriods(actor: Actor, now: Date = new Date()): Promise<PeriodListItem[]> {
    assertPermission(actor, "close_checklist:read");
    const data = await withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(fiscalPeriods)
        .where(eq(fiscalPeriods.organizationId, actor.organizationId))
        .orderBy(asc(fiscalPeriods.startDate), asc(fiscalPeriods.createdAt));
      const cycles = await tx
        .select()
        .from(periodCloses)
        .where(eq(periodCloses.organizationId, actor.organizationId))
        .orderBy(desc(periodCloses.cycle));
      const signoffCounts = await tx
        .select({ periodCloseId: closeSignoffs.periodCloseId, n: sql<number>`count(*)::int` })
        .from(closeSignoffs)
        .where(eq(closeSignoffs.organizationId, actor.organizationId))
        .groupBy(closeSignoffs.periodCloseId);
      const [first] = await tx
        .select({ d: min(journalEntries.postingDate) })
        .from(journalEntries)
        .where(and(eq(journalEntries.organizationId, actor.organizationId), ne(journalEntries.status, "DRAFT")));
      const names = await userNames(tx, cycles.map((c) => c.closedById));
      return { rows, cycles, signoffCounts, first: first?.d ?? null, names };
    });

    const latestByPeriod = new Map<string, (typeof data.cycles)[number]>();
    for (const c of data.cycles) if (!latestByPeriod.has(c.fiscalPeriodId)) latestByPeriod.set(c.fiscalPeriodId, c);
    const signoffsByCycle = new Map(data.signoffCounts.map((s) => [s.periodCloseId, Number(s.n)]));
    const signable = SIGNABLE_KEYS.size;

    const rowFor = (start: Date, end: Date, key: string) =>
      data.rows.find((r) => r.label === key) ??
      data.rows.find((r) => r.startDate.getTime() === start.getTime() && r.endDate.getTime() === end.getTime());

    const build = (key: string, label: string, start: Date, end: Date, kind: "MONTH" | "RANGE", row: FiscalPeriodRow | undefined): PeriodListItem => {
      const covering = data.rows.filter((r) => r.id !== row?.id && LOCK_RANK[r.status as LockLevel] > 0 && overlaps(start, end, r.startDate, r.endDate));
      const ownLevel = (row?.status ?? "OPEN") as LockLevel;
      const cycle = row ? latestByPeriod.get(row.id) : undefined;
      return {
        key,
        label,
        start: start.toISOString(),
        end: end.toISOString(),
        kind,
        fiscalPeriodId: row?.id ?? null,
        ownLevel,
        effectiveLevel: mostRestrictive([ownLevel, ...covering.map((c) => c.status as LockLevel)]),
        coveredBy: covering.map((c) => ({ key: rowKey(c), label: c.label, level: c.status as LockLevel })),
        closeStatus: cycle ? cycle.status : "NOT_STARTED",
        cycle: cycle?.cycle ?? null,
        closedAt: cycle?.closedAt?.toISOString() ?? null,
        closedByName: cycle?.closedById ? (data.names.get(cycle.closedById) ?? null) : null,
        lockLevelApplied: (cycle?.lockLevelApplied as LockLevel | null) ?? null,
        percentAtClose: cycle?.status === "CLOSED" ? percentFromSnapshot(cycle.checklistSnapshot) : null,
        signoffsDone: cycle ? (signoffsByCycle.get(cycle.id) ?? 0) : 0,
        signoffsTotal: signable,
        livePercent: null,
      };
    };

    const items: PeriodListItem[] = [];
    const currentY = now.getUTCFullYear();
    const currentM = now.getUTCMonth() + 1;
    const currentIndex = currentY * 12 + (currentM - 1);
    const earliest = data.first;
    const earliestIndex = earliest ? earliest.getUTCFullYear() * 12 + earliest.getUTCMonth() : currentIndex - 1;
    // At least the previous and current month; back to the first posted activity, capped at 24 months.
    const stopIndex = Math.max(Math.min(earliestIndex, currentIndex - 1), currentIndex - 23);
    for (let index = currentIndex; index >= stopIndex; index -= 1) {
      const y = Math.floor(index / 12);
      const m = (index % 12) + 1;
      const { start, end } = monthBounds(y, m);
      const key = monthKey(y, m);
      items.push(build(key, key, start, end, "MONTH", rowFor(start, end, key)));
    }

    // Non-month periods (annual, quarterly, custom) appear after the months.
    for (const r of data.rows) {
      if (isCalendarMonth(r.startDate, r.endDate)) {
        // A month row outside the displayed window still deserves a line if it is locked.
        const k = monthKeyOf(r.startDate);
        if (!items.some((i) => i.key === k) && LOCK_RANK[r.status as LockLevel] > 0) {
          items.push(build(k, r.label, r.startDate, r.endDate, "MONTH", r));
        }
        continue;
      }
      items.push(build(r.id, r.label, r.startDate, r.endDate, "RANGE", r));
    }

    // Live progress for the focus period only: the previous calendar month, if not locked.
    const pm = previousMonth(currentY, currentM);
    const prev = items.find((i) => i.kind === "MONTH" && i.key === monthKey(pm.year, pm.month));
    if (prev && prev.effectiveLevel === "OPEN") {
      const checklist = await CloseChecklistService.compute(actor, prev.key);
      prev.livePercent = checklist.progress.percent;
    }
    return items;
  },

  /** Everything the period workspace page shows: live checklist, close history, lock-event timeline. */
  async getWorkspace(actor: Actor, ref: PeriodRef | string): Promise<PeriodWorkspace> {
    assertPermission(actor, "close_checklist:read");
    const parsed = typeof ref === "string" ? parsePeriodRef(ref) : ref;
    const meta = await withTenant(actor.organizationId, async (tx) => {
      const resolved = await resolvePeriod(tx, actor.organizationId, parsed);
      let cycles: Array<typeof periodCloses.$inferSelect> = [];
      let events: Array<typeof periodLockEvents.$inferSelect> = [];
      if (resolved.id) {
        cycles = await tx
          .select()
          .from(periodCloses)
          .where(and(eq(periodCloses.organizationId, actor.organizationId), eq(periodCloses.fiscalPeriodId, resolved.id)))
          .orderBy(desc(periodCloses.cycle));
        events = await tx
          .select()
          .from(periodLockEvents)
          .where(and(eq(periodLockEvents.organizationId, actor.organizationId), eq(periodLockEvents.fiscalPeriodId, resolved.id)))
          .orderBy(desc(periodLockEvents.createdAt))
          .limit(200);
      }
      const others = await tx
        .select()
        .from(fiscalPeriods)
        .where(eq(fiscalPeriods.organizationId, actor.organizationId));
      const coveredBy = others
        .filter((r) => r.id !== resolved.id && LOCK_RANK[r.status as LockLevel] > 0 && overlaps(resolved.start, resolved.end, r.startDate, r.endDate))
        .map((r) => ({ key: rowKey(r), label: r.label, level: r.status as LockLevel }));
      const names = await userNames(tx, [...cycles.map((c) => c.closedById), ...events.map((e) => e.actorUserId)]);
      return { resolved, cycles, events, coveredBy, names };
    });

    const checklist = await CloseChecklistService.compute(actor, ref);
    return {
      checklist,
      coveredBy: meta.coveredBy,
      cycles: meta.cycles.map((c) => ({
        id: c.id,
        cycle: c.cycle,
        status: c.status,
        startedAt: c.startedAt.toISOString(),
        closedAt: c.closedAt?.toISOString() ?? null,
        closedByName: c.closedById ? (meta.names.get(c.closedById) ?? null) : null,
        lockLevelApplied: (c.lockLevelApplied as LockLevel | null) ?? null,
        acknowledgedAttentionCount: c.acknowledgedAttentionCount,
        percentAtClose: c.status === "CLOSED" ? percentFromSnapshot(c.checklistSnapshot) : null,
      })),
      events: meta.events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        fromLevel: e.fromLevel as LockLevel,
        toLevel: e.toLevel as LockLevel,
        reason: e.reason,
        acknowledgement: e.acknowledgement,
        actorName: e.actorUserId ? (meta.names.get(e.actorUserId) ?? null) : null,
        actorRole: e.actorRole,
        journalEntryId: e.journalEntryId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },
};
