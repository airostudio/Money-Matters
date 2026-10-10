import { and, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { organizationMemberships, organizations } from "@/db/schema";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import {
  ARCHIVE_REASON_MIN_LENGTH_OWNER,
  ArchiveConfirmationError,
  ArchiveNotPermittedError,
  applyArchive,
  applyRestore,
  normaliseArchiveReason,
} from "./archive-rules";
import { MAX_OWNED_ACTIVE_COMPANIES } from "./limits";
import { CompanyLimitReachedError, OrganizationService } from "./organization-service";

export interface ArchiveByOwnerInput {
  /** What the person typed into "type the company name to confirm". Must equal the company name exactly. */
  confirmName: string;
  /** The "everyone loses access, and webhooks, API keys and automations stop" tick-box. */
  acknowledged: boolean;
  reason: string;
}

/**
 * An organization's own OWNER archiving and restoring it (the platform admin's equivalents live in
 * PlatformAdminService). Archive is reversible and removes nothing - see archive-rules.ts and docs/security.md
 * section 17. Both writes are audited in the organization's own audit log in the same transaction.
 */
export const OrganizationLifecycleService = {
  /**
   * Archive the actor's own company. OWNER only (an ADMINISTRATOR is refused here, at the service layer, whatever the
   * UI shows), and only a human: an API key, AI agent or system actor is refused even with the OWNER role. The company
   * name must be typed exactly, the acknowledgement ticked, and a reason given. The OWNER role is re-verified against
   * the database inside the transaction, so a stale Actor (demoted a moment ago) cannot archive.
   */
  async archive(actor: Actor, input: ArchiveByOwnerInput) {
    if ((actor.type ?? "HUMAN") !== "HUMAN") throw new ArchiveNotPermittedError("human_only");
    if (actor.role !== "OWNER") throw new ArchiveNotPermittedError("owner_only");
    if (input.acknowledged !== true) {
      throw new ArchiveConfirmationError("Tick the box to confirm you understand that everyone loses access until an owner restores the company.");
    }
    const reason = normaliseArchiveReason(input.reason, ARCHIVE_REASON_MIN_LENGTH_OWNER);

    return withTenant(actor.organizationId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.organizationId)).for("update");
      if (!org) throw new ArchiveConfirmationError("That company was not found.");

      const [membership] = await tx
        .select({ role: organizationMemberships.role })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, actor.organizationId),
            eq(organizationMemberships.userId, actor.userId),
            eq(organizationMemberships.isActive, true),
          ),
        );
      if (membership?.role !== "OWNER") throw new ArchiveNotPermittedError("owner_only");

      if (typeof input.confirmName !== "string" || input.confirmName.trim() !== org.name) {
        throw new ArchiveConfirmationError(`Type the company name exactly as shown (${org.name}) to confirm.`);
      }

      const { before, after } = await applyArchive(tx, actor.organizationId, { byUserId: actor.userId, reason });
      await AuditService.record(tx, actor, {
        action: "organization.archived",
        entityType: "Organization",
        entityId: actor.organizationId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt: after.archivedAt, reason },
        metadata: { by: "owner" },
      });
      return after;
    });
  },

  /**
   * Restore an archived company. Called from the company chooser (the company is archived, so there is no org-scoped
   * Actor to use): the user must be an ACTIVE OWNER of it. Refused while the person already owns the maximum number
   * of ACTIVE companies - restoring must not be a way round the cap.
   */
  async restore(userId: string, organizationId: string) {
    const found = await OrganizationService.getMembershipWithState(userId, organizationId);
    if (!found || found.membership.role !== "OWNER") throw new ArchiveNotPermittedError("not_an_owner");

    const actor: Actor = { userId, organizationId, role: "OWNER" };
    return withTenant(organizationId, async (tx) => {
      const [owned] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
        .where(
          and(
            eq(organizationMemberships.userId, userId),
            eq(organizationMemberships.role, "OWNER"),
            eq(organizationMemberships.isActive, true),
            isNull(organizations.archivedAt),
          ),
        );
      if ((owned?.n ?? 0) >= MAX_OWNED_ACTIVE_COMPANIES) throw new CompanyLimitReachedError();

      const { before, after } = await applyRestore(tx, organizationId);
      await AuditService.record(tx, actor, {
        action: "organization.restored",
        entityType: "Organization",
        entityId: organizationId,
        before: { archivedAt: before.archivedAt, reason: before.archiveReason },
        after: { archivedAt: null },
        metadata: { by: "owner" },
      });
      return after;
    });
  },
};
