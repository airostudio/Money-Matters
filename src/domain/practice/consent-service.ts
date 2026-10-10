import { and, asc, eq, sql } from "drizzle-orm";
import { practiceClientConsents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { LinkAlreadyExistsError, LinkDeclinedError, LinkNotActiveError, ProposalNotPossibleError } from "./errors";
import { MAX_PENDING_PROPOSALS_PER_ORG, type LinkStatus } from "./types";

export interface ConsentView {
  id: string;
  practiceId: string;
  practiceName: string;
  status: LinkStatus;
  createdAt: string;
  respondedAt: string | null;
  revokedAt: string | null;
}

function view(r: typeof practiceClientConsents.$inferSelect): ConsentView {
  return {
    id: r.id,
    practiceId: r.practiceId,
    practiceName: r.practiceName,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    respondedAt: r.respondedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

/**
 * The CLIENT side of the practice handshake, in the client organization's own
 * tenant table (`practice_client_consents`). This record — not anything the
 * practice holds — decides whether a practice may read the organization:
 *
 *  - the practice PROPOSES (it cannot make a link ACTIVE);
 *  - only the organization's OWNER / ADMINISTRATOR (`organization:manage`) may
 *    ACCEPT, DECLINE or REVOKE;
 *  - REVOKING is immediate: every practice read first checks this row in its own
 *    short tenant transaction (`assertActive`), so the very next read after a
 *    revocation is refused;
 *  - accepting does NOT grant any data access by itself — the practice staff
 *    member still needs a real membership (and its role's permissions) here.
 *
 * Each accept/decline/revoke writes the organization's own audit log (an
 * ordinary audited tenant mutation with the real actor), so customers can see it.
 *
 * Proposals are written by a practice partner who is not necessarily a member of
 * this organization (they only know its slug). That is the one write into a
 * tenant by a non-member in the system, so it is narrow: one row, status PENDING
 * only, capped at MAX_PENDING_PROPOSALS_PER_ORG per organization, answered with a
 * deliberately generic error whatever the reason.
 */
export const PracticeConsentService = {
  // ------------------------------------------------------------------ client side

  async list(actor: Actor): Promise<ConsentView[]> {
    assertPermission(actor, "organization:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(practiceClientConsents)
        .where(eq(practiceClientConsents.organizationId, actor.organizationId))
        .orderBy(asc(practiceClientConsents.createdAt));
      return rows.map(view);
    });
  },

  /** PENDING, DECLINED or REVOKED -> ACTIVE. The client may re-approve a link it earlier declined or revoked. */
  async accept(actor: Actor, consentId: string): Promise<ConsentView> {
    assertPermission(actor, "organization:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const before = await lockConsent(tx, actor.organizationId, consentId);
      if (before.status === "ACTIVE") throw new LinkAlreadyExistsError("ACTIVE");
      if (before.status === "WITHDRAWN") throw new LinkNotActiveError();
      const [after] = await tx
        .update(practiceClientConsents)
        .set({ status: "ACTIVE", respondedByUserId: actor.userId, respondedAt: new Date(), revokedAt: null, updatedAt: new Date() })
        .where(eq(practiceClientConsents.id, consentId))
        .returning();
      await AuditService.record(tx, actor, {
        action: "practice_link.accepted",
        entityType: "AccountantPractice",
        entityId: before.practiceId,
        before: { status: before.status },
        after: { status: "ACTIVE" },
        metadata: { practiceId: before.practiceId },
      });
      return view(after!);
    });
  },

  async decline(actor: Actor, consentId: string): Promise<ConsentView> {
    assertPermission(actor, "organization:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const before = await lockConsent(tx, actor.organizationId, consentId);
      if (before.status !== "PENDING") throw new LinkNotActiveError();
      const [after] = await tx
        .update(practiceClientConsents)
        .set({ status: "DECLINED", respondedByUserId: actor.userId, respondedAt: new Date(), updatedAt: new Date() })
        .where(eq(practiceClientConsents.id, consentId))
        .returning();
      await AuditService.record(tx, actor, {
        action: "practice_link.declined",
        entityType: "AccountantPractice",
        entityId: before.practiceId,
        before: { status: before.status },
        after: { status: "DECLINED" },
        metadata: { practiceId: before.practiceId },
      });
      return view(after!);
    });
  },

  /** ACTIVE -> REVOKED, effective for the very next read. */
  async revoke(actor: Actor, consentId: string): Promise<ConsentView> {
    assertPermission(actor, "organization:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const before = await lockConsent(tx, actor.organizationId, consentId);
      if (before.status !== "ACTIVE") throw new LinkNotActiveError();
      const [after] = await tx
        .update(practiceClientConsents)
        .set({ status: "REVOKED", respondedByUserId: actor.userId, revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(practiceClientConsents.id, consentId))
        .returning();
      await AuditService.record(tx, actor, {
        action: "practice_link.revoked",
        entityType: "AccountantPractice",
        entityId: before.practiceId,
        before: { status: "ACTIVE" },
        after: { status: "REVOKED" },
        metadata: { practiceId: before.practiceId },
      });
      return view(after!);
    });
  },

  // ---------------------------------------------------------------- practice side

  /** The consent status for this practice, or null if none exists. One short tenant transaction. */
  async statusFor(organizationId: string, practiceId: string): Promise<LinkStatus | null> {
    return withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select({ status: practiceClientConsents.status })
        .from(practiceClientConsents)
        .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.practiceId, practiceId)));
      return row?.status ?? null;
    });
  },

  /** Refuses unless the client currently has this practice ACTIVE. Called immediately before every client read. */
  async assertActive(organizationId: string, practiceId: string): Promise<void> {
    if ((await PracticeConsentService.statusFor(organizationId, practiceId)) !== "ACTIVE") throw new LinkNotActiveError();
  },

  /**
   * Writes (or re-opens) the PENDING proposal in the client organization. Idempotent for an
   * already-PENDING one. Deliberately generic failure (ProposalNotPossibleError) when the
   * organization is at its pending cap.
   */
  async propose(
    organizationId: string,
    practice: { id: string; name: string },
    proposerUserId: string,
  ): Promise<{ consentId: string; status: LinkStatus; created: boolean }> {
    return withTenant(organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(practiceClientConsents)
        .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.practiceId, practice.id)))
        .for("update");

      if (existing?.status === "ACTIVE") throw new LinkAlreadyExistsError("ACTIVE");
      if (existing?.status === "PENDING") return { consentId: existing.id, status: "PENDING" as const, created: false };
      if (existing?.status === "DECLINED") throw new LinkDeclinedError();

      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(practiceClientConsents)
        .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.status, "PENDING")));
      if (n >= MAX_PENDING_PROPOSALS_PER_ORG) throw new ProposalNotPossibleError();

      let consentId: string;
      if (existing) {
        await tx
          .update(practiceClientConsents)
          .set({
            status: "PENDING",
            practiceName: practice.name,
            proposedByUserId: proposerUserId,
            respondedByUserId: null,
            respondedAt: null,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(practiceClientConsents.id, existing.id));
        consentId = existing.id;
      } else {
        const [row] = await tx
          .insert(practiceClientConsents)
          .values({ organizationId, practiceId: practice.id, practiceName: practice.name, status: "PENDING", proposedByUserId: proposerUserId })
          .returning({ id: practiceClientConsents.id });
        consentId = row!.id;
      }
      await AuditService.recordPracticeNote(tx, organizationId, {
        actorUserId: proposerUserId,
        practiceId: practice.id,
        action: "practice_link.proposed",
        entityId: practice.id,
      });
      return { consentId, status: "PENDING" as const, created: true };
    });
  },

  /** The practice withdraws a PENDING proposal, or ends an ACTIVE link itself. */
  async withdraw(organizationId: string, practiceId: string, userId: string): Promise<LinkStatus | null> {
    return withTenant(organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(practiceClientConsents)
        .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.practiceId, practiceId)))
        .for("update");
      if (!existing || (existing.status !== "PENDING" && existing.status !== "ACTIVE")) return existing?.status ?? null;
      await tx
        .update(practiceClientConsents)
        .set({ status: "WITHDRAWN", revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(practiceClientConsents.id, existing.id));
      await AuditService.recordPracticeNote(tx, organizationId, {
        actorUserId: userId,
        practiceId,
        action: "practice_link.withdrawn_by_practice",
        entityId: practiceId,
        metadata: { from: existing.status },
      });
      return "WITHDRAWN" as const;
    });
  },

  /**
   * An informational note in the client's audit log (opaque practice id + actor), written ONLY
   * while the link is ACTIVE — a practice with no consent leaves nothing in the client's books.
   */
  async recordNoteIfActive(
    organizationId: string,
    practiceId: string,
    userId: string,
    action: string,
    entityId: string,
  ): Promise<boolean> {
    return withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select({ status: practiceClientConsents.status })
        .from(practiceClientConsents)
        .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.practiceId, practiceId)));
      if (row?.status !== "ACTIVE") return false;
      await AuditService.recordPracticeNote(tx, organizationId, { actorUserId: userId, practiceId, action, entityId });
      return true;
    });
  },
};

async function lockConsent(tx: Parameters<Parameters<typeof withTenant>[1]>[0], organizationId: string, consentId: string) {
  const [row] = await tx
    .select()
    .from(practiceClientConsents)
    .where(and(eq(practiceClientConsents.id, consentId), eq(practiceClientConsents.organizationId, organizationId)))
    .for("update");
  if (!row) throw new LinkNotActiveError();
  return row;
}
