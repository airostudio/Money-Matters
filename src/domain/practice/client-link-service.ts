import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  clientHealthSnapshots,
  practiceClientGroupMembers,
  practiceClientGroups,
  practiceClientLinks,
  practices,
  users,
} from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { PracticeConsentService } from "./consent-service";
import { PracticeAccess } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import {
  ClientLimitReachedError,
  ClientLinkNotFoundError,
  InvalidAssigneeError,
  LinkAlreadyExistsError,
  ProposalNotPossibleError,
} from "./errors";
import { MAX_CLIENTS_PER_PRACTICE, MAX_BULK_SELECTION, type LinkStatus, type PracticeActor } from "./types";

export interface ClientLinkView {
  linkId: string;
  clientOrganizationId: string;
  clientName: string;
  clientSlug: string;
  status: LinkStatus;
  assignedUserId: string | null;
  assignedName: string | null;
  statusVerifiedAt: string | null;
  statusChangedAt: string;
  groups: Array<{ id: string; name: string }>;
}

/** Statuses that count toward the per-practice client cap. */
const LIVE_STATUSES: LinkStatus[] = ["PENDING", "ACTIVE"];

/**
 * Writes the observed client-side status onto the practice's own link rows and
 * audits each change. When a link is no longer ACTIVE its materialised health
 * snapshot is blanked (state LINK_INACTIVE, every indicator NULL), so the
 * practice stops holding client-derived dashboard figures for a client that has
 * withdrawn consent. Practice-owned history (tasks, notes, workpaper snapshots)
 * is retained — see docs/security.md section 13.
 */
export async function applyObservedStatuses(
  tx: UserScopeDb,
  actor: PracticeActor,
  practiceId: string,
  observed: Array<{ clientOrganizationId: string; status: LinkStatus | null }>,
): Promise<Array<{ clientOrganizationId: string; from: LinkStatus; to: LinkStatus }>> {
  const changes: Array<{ clientOrganizationId: string; from: LinkStatus; to: LinkStatus }> = [];
  const now = new Date();
  for (const o of observed) {
    const [link] = await tx
      .select()
      .from(practiceClientLinks)
      .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, o.clientOrganizationId)));
    if (!link) continue;
    await tx
      .update(practiceClientLinks)
      .set({ statusVerifiedAt: now })
      .where(eq(practiceClientLinks.id, link.id));
    // A missing consent row cannot be re-created by the practice; leave the mirror alone.
    if (o.status === null || o.status === link.status) continue;

    await tx
      .update(practiceClientLinks)
      .set({
        status: o.status,
        statusChangedAt: now,
        updatedAt: now,
      })
      .where(eq(practiceClientLinks.id, link.id));
    if (o.status !== "ACTIVE") {
      await tx
        .update(clientHealthSnapshots)
        .set({
          state: "LINK_INACTIVE",
          detail: "The client has ended this practice's access.",
          computedAt: now,
          computedByUserId: actor.userId,
          periodLabel: null,
          lockLevel: null,
          booksPercent: null,
          blockingCount: null,
          attentionCount: null,
          unreconciledCount: null,
          uncategorisedCount: null,
          draftPayRuns: null,
          taxLockedThrough: null,
        })
        .where(and(eq(clientHealthSnapshots.practiceId, practiceId), eq(clientHealthSnapshots.clientOrganizationId, o.clientOrganizationId)));
    }
    await PracticeAuditService.record(tx, {
      practiceId,
      actorUserId: actor.userId,
      actorType: actor.type,
      action: "client_link.status_observed",
      entityType: "ClientLink",
      entityId: link.id,
      before: { status: link.status },
      after: { status: o.status },
      metadata: { clientOrganizationId: o.clientOrganizationId },
    });
    changes.push({ clientOrganizationId: o.clientOrganizationId, from: link.status, to: o.status });
  }
  return changes;
}

/**
 * Client links: the practice's side of the handshake (the authoritative consent
 * record is the client's own, see PracticeConsentService). Strictly sequential:
 * every client check is its own short tenant transaction, one after another,
 * never `Promise.all` — and bounded (MAX_BULK_SELECTION per verification call).
 */
export const ClientLinkService = {
  /** MANAGER+. Proposes the link to the organization with this slug; it stays PENDING until the client accepts. */
  async propose(actor: PracticeActor, practiceId: string, clientSlug: string): Promise<ClientLinkView> {
    const slug = clientSlug.trim().toLowerCase();

    // 1. Practice side: role, cap, practice name.
    const { practiceName, over } = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Proposing a client link");
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), inArray(practiceClientLinks.status, LIVE_STATUSES)));
      const [practice] = await tx.select({ name: practices.name }).from(practices).where(eq(practices.id, practiceId));
      return { practiceName: practice!.name, over: n >= MAX_CLIENTS_PER_PRACTICE };
    });
    if (over) throw new ClientLimitReachedError();

    // 2. Resolve the organization. Anything wrong here is the same generic error.
    const org = slug ? await OrganizationService.getBySlug(slug) : null;
    // An ARCHIVED organization is unavailable: the same generic error as a slug that does not exist (nothing is disclosed).
    if (!org || org.archivedAt) throw new ProposalNotPossibleError();

    // 3. Client side: the PENDING proposal in the client's own tenant table.
    const proposal = await PracticeConsentService.propose(org.id, { id: practiceId, name: practiceName }, actor.userId);

    // 4. Practice side: the working copy + audit.
    return withUserScope(actor.userId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, org.id)));
      let linkId: string;
      if (existing) {
        if (existing.status === "ACTIVE") throw new LinkAlreadyExistsError("ACTIVE");
        await tx
          .update(practiceClientLinks)
          .set({ status: "PENDING", clientName: org.name, clientSlug: org.slug, proposedByUserId: actor.userId, statusChangedAt: new Date(), updatedAt: new Date() })
          .where(eq(practiceClientLinks.id, existing.id));
        linkId = existing.id;
      } else {
        const [row] = await tx
          .insert(practiceClientLinks)
          .values({ practiceId, clientOrganizationId: org.id, clientName: org.name, clientSlug: org.slug, status: "PENDING", proposedByUserId: actor.userId })
          .returning({ id: practiceClientLinks.id });
        linkId = row!.id;
      }
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_link.proposed",
        entityType: "ClientLink",
        entityId: linkId,
        after: { clientOrganizationId: org.id, clientName: org.name },
        metadata: proposal.created ? undefined : { alreadyPending: true },
      });
      const views = await listLinks(tx, practiceId, { onlyOrganizationId: org.id });
      return views[0]!;
    });
  },

  /** Every link of the practice (any status) with assignee and groups. Readable by all staff. */
  async list(actor: PracticeActor, practiceId: string, opts: { statuses?: LinkStatus[] } = {}): Promise<ClientLinkView[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      return listLinks(tx, practiceId, { statuses: opts.statuses });
    });
  },

  /**
   * Checks the client's own consent record for up to MAX_BULK_SELECTION links, ONE AT A TIME,
   * and updates the practice's working copies. Returns what changed.
   */
  async verify(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[]) {
    if (clientOrganizationIds.length > MAX_BULK_SELECTION) {
      throw new Error(`At most ${MAX_BULK_SELECTION} links can be verified in one call.`);
    }
    await withUserScope(actor.userId, (tx) => PracticeAccess.load(tx, actor, practiceId));

    const observed: Array<{ clientOrganizationId: string; status: LinkStatus | null }> = [];
    for (const clientOrganizationId of clientOrganizationIds) {
      observed.push({ clientOrganizationId, status: await PracticeConsentService.statusFor(clientOrganizationId, practiceId) });
    }
    return withUserScope(actor.userId, (tx) => applyObservedStatuses(tx, actor, practiceId, observed));
  },

  /**
   * The practice withdraws a PENDING proposal or ends an ACTIVE link itself. Partner for an
   * ACTIVE link, MANAGER+ for a PENDING one.
   */
  async withdraw(actor: PracticeActor, practiceId: string, clientOrganizationId: string): Promise<void> {
    const link = await withUserScope(actor.userId, async (tx) => {
      const [row] = await tx
        .select()
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
      if (!row) {
        await PracticeAccess.load(tx, actor, practiceId);
        throw new ClientLinkNotFoundError();
      }
      await PracticeAccess.require(tx, actor, practiceId, row.status === "ACTIVE" ? "PARTNER" : "MANAGER", "Ending a client link");
      return row;
    });
    await PracticeConsentService.withdraw(clientOrganizationId, practiceId, actor.userId);
    await withUserScope(actor.userId, async (tx) => {
      const now = new Date();
      await tx
        .update(practiceClientLinks)
        .set({ status: "WITHDRAWN", statusChangedAt: now, updatedAt: now })
        .where(eq(practiceClientLinks.id, link.id));
      await tx
        .update(clientHealthSnapshots)
        .set({
          state: "LINK_INACTIVE",
          detail: "The practice ended this link.",
          computedAt: now,
          computedByUserId: actor.userId,
          periodLabel: null,
          lockLevel: null,
          booksPercent: null,
          blockingCount: null,
          attentionCount: null,
          unreconciledCount: null,
          uncategorisedCount: null,
          draftPayRuns: null,
          taxLockedThrough: null,
        })
        .where(and(eq(clientHealthSnapshots.practiceId, practiceId), eq(clientHealthSnapshots.clientOrganizationId, clientOrganizationId)));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "client_link.withdrawn",
        entityType: "ClientLink",
        entityId: link.id,
        before: { status: link.status },
        after: { status: "WITHDRAWN" },
      });
    });
  },

  /**
   * MANAGER+. Makes `assigneeUserId` (an ACTIVE member of the practice, or null to clear) the
   * responsible staff member. Assignment grants the assignee NO access to the client. When the
   * link is ACTIVE the client's own audit log gets an informational note (opaque practice id
   * and the actor only).
   */
  async assign(actor: PracticeActor, practiceId: string, clientOrganizationId: string, assigneeUserId: string | null): Promise<void> {
    await withUserScope(actor.userId, (tx) => assignWithin(tx, actor, practiceId, [clientOrganizationId], assigneeUserId));
    await PracticeConsentService.recordNoteIfActive(clientOrganizationId, practiceId, actor.userId, "practice_link.staff_assigned", practiceId);
  },
};

/** Shared by single and bulk assignment: one user-scoped transaction, no client access. */
export async function assignWithin(
  tx: UserScopeDb,
  actor: PracticeActor,
  practiceId: string,
  clientOrganizationIds: string[],
  assigneeUserId: string | null,
): Promise<void> {
  await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Assigning staff to clients");
  if (assigneeUserId && !(await PracticeAccess.isActiveMember(tx, practiceId, assigneeUserId))) throw new InvalidAssigneeError();
  for (const clientOrganizationId of clientOrganizationIds) {
    const [link] = await tx
      .select()
      .from(practiceClientLinks)
      .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
    if (!link) throw new ClientLinkNotFoundError();
    await tx
      .update(practiceClientLinks)
      .set({ assignedUserId: assigneeUserId, updatedAt: new Date() })
      .where(eq(practiceClientLinks.id, link.id));
    await PracticeAuditService.record(tx, {
      practiceId,
      actorUserId: actor.userId,
      actorType: actor.type,
      action: "client_link.assigned",
      entityType: "ClientLink",
      entityId: link.id,
      before: { assignedUserId: link.assignedUserId },
      after: { assignedUserId: assigneeUserId },
      metadata: { clientOrganizationId },
    });
  }
}

export async function listLinks(
  tx: UserScopeDb,
  practiceId: string,
  opts: { statuses?: LinkStatus[]; onlyOrganizationId?: string },
): Promise<ClientLinkView[]> {
  const conds = [eq(practiceClientLinks.practiceId, practiceId)];
  if (opts.statuses) conds.push(inArray(practiceClientLinks.status, opts.statuses));
  if (opts.onlyOrganizationId) conds.push(eq(practiceClientLinks.clientOrganizationId, opts.onlyOrganizationId));
  const rows = await tx
    .select({ link: practiceClientLinks, assignedName: users.name })
    .from(practiceClientLinks)
    .leftJoin(users, eq(users.id, practiceClientLinks.assignedUserId))
    .where(and(...conds))
    .orderBy(asc(practiceClientLinks.clientName));
  const groupRows = await tx
    .select({
      clientOrganizationId: practiceClientGroupMembers.clientOrganizationId,
      id: practiceClientGroups.id,
      name: practiceClientGroups.name,
    })
    .from(practiceClientGroupMembers)
    .innerJoin(practiceClientGroups, eq(practiceClientGroups.id, practiceClientGroupMembers.groupId))
    .where(eq(practiceClientGroupMembers.practiceId, practiceId));
  const groupsByClient = new Map<string, Array<{ id: string; name: string }>>();
  for (const g of groupRows) {
    const list = groupsByClient.get(g.clientOrganizationId) ?? [];
    list.push({ id: g.id, name: g.name });
    groupsByClient.set(g.clientOrganizationId, list);
  }
  return rows.map(({ link, assignedName }) => ({
    linkId: link.id,
    clientOrganizationId: link.clientOrganizationId,
    clientName: link.clientName,
    clientSlug: link.clientSlug,
    status: link.status,
    assignedUserId: link.assignedUserId,
    assignedName: assignedName ?? null,
    statusVerifiedAt: link.statusVerifiedAt?.toISOString() ?? null,
    statusChangedAt: link.statusChangedAt.toISOString(),
    groups: (groupsByClient.get(link.clientOrganizationId) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}
