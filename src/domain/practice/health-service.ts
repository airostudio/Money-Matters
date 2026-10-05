import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { clientHealthSnapshots, practiceClientLinks, practiceTasks } from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { monthKey, previousMonth } from "@/domain/close/period-ref";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { loadClientAccessMap, explainNotAMember } from "./client-access";
import { applyObservedStatuses, listLinks, type ClientLinkView } from "./client-link-service";
import { PracticeConsentService } from "./consent-service";
import { PracticeAccess } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { BulkSelectionError, ClientLinkNotFoundError, LinkNotActiveError } from "./errors";
import {
  compareByUrgency,
  deriveRow,
  describeSnapshotAge,
  isSnapshotStale,
  type DeadlineFacts,
  type HealthFacts,
  type RowIndicators,
  type ViewerVisibility,
} from "./traffic-light";
import { DASHBOARD_PAGE_SIZE, MAX_BULK_SELECTION, type PracticeActor } from "./types";

export type RefreshState = "OK" | "NO_ACCESS" | "LINK_INACTIVE" | "ERROR";

export interface RefreshResult {
  clientOrganizationId: string;
  clientName: string;
  state: RefreshState;
  message?: string;
  computedAt?: string;
}

export interface DashboardRow {
  linkId: string;
  clientOrganizationId: string;
  clientName: string;
  clientSlug: string;
  assignedUserId: string | null;
  assignedName: string | null;
  groups: Array<{ id: string; name: string }>;
  /** The viewer's real role in this client (the rows shown are only clients the viewer can open). */
  viewerRole: string;
  snapshot: { computedAt: string; age: string; stale: boolean; state: string; detail: string | null } | null;
  indicators: RowIndicators;
  nextDeadline: DeadlineFacts;
}

export interface DashboardPage {
  rows: DashboardRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  /** Rows matching the filters, before paging. */
  totalMatching: number;
  /** ACTIVE links of the practice that the viewer cannot open (not a member of the client): counted, never listed or measured. */
  notAccessibleCount: number;
  /** Rows dropped from this page because verification found the client had ended access. */
  endedDuringLoad: number;
  generatedAt: string;
}

export interface DashboardOptions {
  page?: number;
  filter?: "ALL" | "NEEDS_INTERVENTION";
  groupId?: string;
  assignedTo?: string;
  /** Verify each page row's consent sequentially before showing it (default true). */
  verifyLinks?: boolean;
  now?: Date;
}

/** Previous calendar month — the "month-end" a practice is normally closing. */
export function focusPeriodKey(now: Date): string {
  const pm = previousMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return monthKey(pm.year, pm.month);
}

function visibilityFor(role: string): ViewerVisibility {
  const r = role as Parameters<typeof roleHasPermission>[0];
  return {
    books: roleHasPermission(r, "close_checklist:read"),
    reconciliation: roleHasPermission(r, "bank_account:read"),
    payroll: roleHasPermission(r, "payrun:read"),
  };
}

const toFacts = (s: typeof clientHealthSnapshots.$inferSelect): HealthFacts => ({
  state: s.state,
  periodLabel: s.periodLabel,
  lockLevel: s.lockLevel,
  booksPercent: s.booksPercent,
  blockingCount: s.blockingCount,
  attentionCount: s.attentionCount,
  unreconciledCount: s.unreconciledCount,
  uncategorisedCount: s.uncategorisedCount,
  draftPayRuns: s.draftPayRuns,
  taxLockedThrough: s.taxLockedThrough,
});

/** Open BAS/TAX deadlines and overdue-task counts per client, from the PRACTICE's own tasks — one query pair, no client access. */
async function loadDeadlineFacts(tx: UserScopeDb, practiceId: string, today: string): Promise<Map<string, DeadlineFacts>> {
  const out = new Map<string, DeadlineFacts>();
  const facts = (id: string) => {
    let f = out.get(id);
    if (!f) {
      f = { nextDueDate: null, nextTitle: null, overdueTasks: 0 };
      out.set(id, f);
    }
    return f;
  };
  const deadlines = await tx
    .select({ client: practiceTasks.clientOrganizationId, title: practiceTasks.title, due: practiceTasks.dueDate })
    .from(practiceTasks)
    .where(
      and(
        eq(practiceTasks.practiceId, practiceId),
        inArray(practiceTasks.status, ["OPEN", "IN_PROGRESS"]),
        inArray(practiceTasks.category, ["BAS", "TAX"]),
        sql`${practiceTasks.clientOrganizationId} is not null and ${practiceTasks.dueDate} is not null`,
      ),
    )
    .orderBy(practiceTasks.dueDate);
  for (const d of deadlines) {
    const f = facts(d.client!);
    if (!f.nextDueDate) {
      f.nextDueDate = d.due;
      f.nextTitle = d.title;
    }
  }
  const overdue = await tx
    .select({ client: practiceTasks.clientOrganizationId, n: sql<number>`count(*)::int` })
    .from(practiceTasks)
    .where(
      and(
        eq(practiceTasks.practiceId, practiceId),
        inArray(practiceTasks.status, ["OPEN", "IN_PROGRESS"]),
        lt(practiceTasks.dueDate, today),
        sql`${practiceTasks.clientOrganizationId} is not null`,
      ),
    )
    .groupBy(practiceTasks.clientOrganizationId);
  for (const o of overdue) facts(o.client!).overdueTasks = Number(o.n);
  return out;
}

const EMPTY_DEADLINE: DeadlineFacts = { nextDueDate: null, nextTitle: null, overdueTasks: 0 };

/**
 * The practice dashboard and its materialised health snapshots (master spec s.42).
 *
 * DB-connection discipline (docs/security.md section 13; the Supabase session
 * pooler caps the whole project at ~15 clients): the dashboard is READ from
 * `client_health_snapshots` — one user-scoped transaction of set-based queries —
 * and never recomputed across clients on a page view. Fresh figures come from an
 * explicit Refresh, which runs ONE CLIENT AT A TIME (never Promise.all), each
 * client's measurements as short sequential tenant transactions using the staff
 * member's real role there. Every list is bounded: DASHBOARD_PAGE_SIZE rows per
 * page, MAX_BULK_SELECTION per bulk refresh, MAX_CLIENTS_PER_PRACTICE links.
 *
 * Who sees what: a row is shown only for a client the VIEWER is a member of
 * (their own membership decides, not the practice link), and each indicator is
 * redacted by the viewer's own role in that client — the snapshot may have been
 * refreshed by a colleague with more permissions, so payroll is "not visible to
 * your role" unless the viewer holds `payrun:read` there.
 */
export const HealthService = {
  /** One client. Never throws for a per-client problem — the outcome is in the result. */
  async refreshClient(actor: PracticeActor, practiceId: string, clientOrganizationId: string, now: Date = new Date()): Promise<RefreshResult> {
    // 1. Practice side: membership, the link's working copy.
    const link = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const [row] = await tx
        .select()
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
      if (!row) throw new ClientLinkNotFoundError();
      return row;
    });
    const base = { clientOrganizationId, clientName: link.clientName };
    if (link.status !== "ACTIVE") {
      return { ...base, state: "LINK_INACTIVE", message: new LinkNotActiveError().message };
    }

    // 2. The staff member's real membership role in the client.
    const membership = await OrganizationService.getMembership(actor.userId, clientOrganizationId);
    if (!membership) {
      return { ...base, state: "NO_ACCESS", message: (await explainNotAMember(clientOrganizationId, link.clientName)).message };
    }
    const clientActor: Actor = { userId: actor.userId, organizationId: clientOrganizationId, role: membership.role, type: actor.type };

    // 3. Measure — sequentially, the client's own consent re-checked before each group of reads.
    try {
      const guard = async (): Promise<boolean> => (await PracticeConsentService.statusFor(clientOrganizationId, practiceId)) === "ACTIVE";
      const inactive = async (): Promise<RefreshResult> => {
        const status = await PracticeConsentService.statusFor(clientOrganizationId, practiceId);
        await withUserScope(actor.userId, (tx) => applyObservedStatuses(tx, actor, practiceId, [{ clientOrganizationId, status }]));
        return { ...base, state: "LINK_INACTIVE", message: new LinkNotActiveError().message };
      };

      const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(membership.role, p);
      const m = {
        periodLabel: null as string | null,
        lockLevel: null as string | null,
        booksPercent: null as number | null,
        blockingCount: null as number | null,
        attentionCount: null as number | null,
        unreconciledCount: null as number | null,
        uncategorisedCount: null as number | null,
        draftPayRuns: null as number | null,
        taxLockedThrough: null as string | null,
      };

      if (can("close_checklist:read")) {
        if (!(await guard())) return inactive();
        const checklist = await CloseChecklistService.compute(clientActor, focusPeriodKey(now));
        m.periodLabel = checklist.period.label;
        m.lockLevel = checklist.period.lockLevel;
        m.booksPercent = checklist.progress.percent;
        m.blockingCount = checklist.blocking.length;
        m.attentionCount = checklist.items.filter((i) => i.status === "ATTENTION").length;
        if (!(await guard())) return inactive();
        m.taxLockedThrough = await PeriodCloseService.getTaxLockedThrough(clientActor);
      }
      if (can("bank_account:read")) {
        if (!(await guard())) return inactive();
        const summary = await ReconciliationService.getSummary(clientActor);
        m.unreconciledCount = summary.unreconciled;
        m.uncategorisedCount = summary.uncategorised;
      }
      if (can("payrun:read")) {
        if (!(await guard())) return inactive();
        m.draftPayRuns = await PayRunService.countDrafts(clientActor);
      }

      // 4. Practice side: store the snapshot (upsert) + audit.
      await withUserScope(actor.userId, async (tx) => {
        await PracticeAccess.load(tx, actor, practiceId);
        const values = {
          practiceId,
          clientOrganizationId,
          state: "OK",
          detail: null,
          computedAt: now,
          computedByUserId: actor.userId,
          computedByRole: membership.role,
          ...m,
        };
        await tx
          .insert(clientHealthSnapshots)
          .values(values)
          .onConflictDoUpdate({ target: [clientHealthSnapshots.practiceId, clientHealthSnapshots.clientOrganizationId], set: values });
        await PracticeAuditService.record(tx, {
          practiceId,
          actorUserId: actor.userId,
          actorType: actor.type,
          action: "client_health.refreshed",
          entityType: "ClientLink",
          entityId: link.id,
          after: { period: m.periodLabel, booksPercent: m.booksPercent, roleUsed: membership.role },
          metadata: { clientOrganizationId },
        });
      });
      return { ...base, state: "OK", computedAt: now.toISOString() };
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return { ...base, state: "ERROR", message: error.message };
      }
      return { ...base, state: "ERROR", message: error instanceof Error ? error.message : "Refresh failed." };
    }
  },

  /** Up to MAX_BULK_SELECTION clients, strictly one after another. */
  async refreshMany(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[], now: Date = new Date()): Promise<RefreshResult[]> {
    const ids = [...new Set(clientOrganizationIds)];
    if (ids.length < 1 || ids.length > MAX_BULK_SELECTION) throw new BulkSelectionError();
    await withUserScope(actor.userId, (tx) => PracticeAccess.load(tx, actor, practiceId));
    const results: RefreshResult[] = [];
    for (const id of ids) {
      try {
        results.push(await HealthService.refreshClient(actor, practiceId, id, now));
      } catch (error) {
        results.push({ clientOrganizationId: id, clientName: "", state: "ERROR", message: error instanceof Error ? error.message : "Refresh failed." });
      }
    }
    return results;
  },

  /** The dashboard page: snapshots only; no client data is read except the (sequential) consent checks of this page's rows. */
  async dashboard(actor: PracticeActor, practiceId: string, opts: DashboardOptions = {}): Promise<DashboardPage> {
    const now = opts.now ?? new Date();
    const today = now.toISOString().slice(0, 10);
    const access = await loadClientAccessMap(actor.userId);

    const loaded = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const links = await listLinks(tx, practiceId, { statuses: ["ACTIVE"] });
      const snaps = await tx.select().from(clientHealthSnapshots).where(eq(clientHealthSnapshots.practiceId, practiceId));
      const deadlines = await loadDeadlineFacts(tx, practiceId, today);
      return { links, snaps, deadlines };
    });

    const snapByClient = new Map(loaded.snaps.map((s) => [s.clientOrganizationId, s]));
    const accessible = loaded.links.filter((l) => access.has(l.clientOrganizationId));
    const notAccessibleCount = loaded.links.length - accessible.length;

    const built = accessible
      .filter((l) => !opts.groupId || l.groups.some((g) => g.id === opts.groupId))
      .filter((l) => !opts.assignedTo || l.assignedUserId === opts.assignedTo)
      .map((l) => buildRow(l, access.get(l.clientOrganizationId)!.role, snapByClient.get(l.clientOrganizationId), loaded.deadlines.get(l.clientOrganizationId) ?? EMPTY_DEADLINE, today, now))
      .filter((r) => (opts.filter === "NEEDS_INTERVENTION" ? r.indicators.needsIntervention : true))
      .sort((a, b) => compareByUrgency({ ...a.indicators, name: a.clientName }, { ...b.indicators, name: b.clientName }));

    const pageSize = DASHBOARD_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(built.length / pageSize));
    const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), totalPages);
    let rows = built.slice((page - 1) * pageSize, page * pageSize);

    // Verify THIS page's consent, one client at a time; drop (and record) any the client has ended.
    let endedDuringLoad = 0;
    if (opts.verifyLinks !== false && rows.length > 0) {
      const observed: Array<{ clientOrganizationId: string; status: Awaited<ReturnType<typeof PracticeConsentService.statusFor>> }> = [];
      for (const r of rows) {
        observed.push({ clientOrganizationId: r.clientOrganizationId, status: await PracticeConsentService.statusFor(r.clientOrganizationId, practiceId) });
      }
      const ended = new Set(observed.filter((o) => o.status !== null && o.status !== "ACTIVE").map((o) => o.clientOrganizationId));
      await withUserScope(actor.userId, (tx) => applyObservedStatuses(tx, actor, practiceId, observed));
      endedDuringLoad = ended.size;
      rows = rows.filter((r) => !ended.has(r.clientOrganizationId));
    }

    return {
      rows,
      page,
      pageSize,
      totalPages,
      totalMatching: built.length,
      notAccessibleCount,
      endedDuringLoad,
      generatedAt: now.toISOString(),
    };
  },
};

function buildRow(
  l: ClientLinkView,
  role: string,
  snap: typeof clientHealthSnapshots.$inferSelect | undefined,
  deadline: DeadlineFacts,
  today: string,
  now: Date,
): DashboardRow {
  const facts = snap && snap.state === "OK" ? toFacts(snap) : null;
  const indicators = deriveRow(facts, visibilityFor(role), deadline, today);
  return {
    linkId: l.linkId,
    clientOrganizationId: l.clientOrganizationId,
    clientName: l.clientName,
    clientSlug: l.clientSlug,
    assignedUserId: l.assignedUserId,
    assignedName: l.assignedName,
    groups: l.groups,
    viewerRole: role,
    snapshot: snap
      ? {
          computedAt: snap.computedAt.toISOString(),
          age: describeSnapshotAge(snap.computedAt, now),
          stale: isSnapshotStale(snap.computedAt, now),
          state: snap.state,
          detail: snap.detail,
        }
      : null,
    indicators,
    nextDeadline: deadline,
  };
}
