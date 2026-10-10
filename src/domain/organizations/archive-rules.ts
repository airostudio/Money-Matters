import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { ORGANIZATION_ARCHIVED_DIGEST } from "./archived-digest";
// (Deliberately does not import membership-rules: that module re-exports this one, see its footer.)

/**
 * Archive / restore rules shared by an organization's own OWNER (OrganizationLifecycleService) and the platform
 * admin section (PlatformAdminService) - one write path, so what "archived" means cannot drift between the two.
 *
 * ARCHIVE IS NOT DELETION. It sets three columns on the organizations row and nothing else: no tenant row is
 * touched, no membership or seat changes, no API key / webhook / automation setting is edited. Everything is
 * enforced at the ENTRY POINTS instead (docs/security.md section 17), so restoring - clearing the three columns -
 * returns the company exactly as it was. There is deliberately no erase path anywhere in the application.
 *
 * Every function here takes a transaction and locks the organization row first (`lockOrganization`), the same
 * serialisation point membership changes use, so archive/restore race neither each other nor a member change.
 */

export const ARCHIVE_REASON_MIN_LENGTH_OWNER = 5;
export const ARCHIVE_REASON_MIN_LENGTH_ADMIN = 10;
export const ARCHIVE_REASON_MAX_LENGTH = 500;

/**
 * Thrown by every entry point that resolves a request-scoped actor for an organization that is archived. Carries a
 * digest the org error boundary recognises (archived-digest.ts), so a server action fired from a stale tab shows the
 * friendly archived state rather than "Application error".
 */
export class OrganizationArchivedError extends Error {
  readonly digest = ORGANIZATION_ARCHIVED_DIGEST;

  constructor(public readonly organizationId?: string) {
    super("This company is archived. Nobody can view or change its data until an owner restores it.");
    this.name = "OrganizationArchivedError";
  }
}

export class OrganizationAlreadyArchivedError extends Error {
  constructor() {
    super("This company is already archived.");
    this.name = "OrganizationAlreadyArchivedError";
  }
}

export class OrganizationNotArchivedError extends Error {
  constructor() {
    super("This company is not archived.");
    this.name = "OrganizationNotArchivedError";
  }
}

export class ArchiveNotPermittedError extends Error {
  constructor(why: "owner_only" | "human_only" | "not_an_owner") {
    super(
      why === "owner_only"
        ? "Only an Owner can archive this company. Ask an Owner to do it."
        : why === "human_only"
          ? "Archiving a company can only be done by a signed-in person, not by an API key, an AI agent or an automated process."
          : "Only an Owner of this company can restore it.",
    );
    this.name = "ArchiveNotPermittedError";
  }
}

export class ArchiveConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveConfirmationError";
  }
}

export class InvalidArchiveReasonError extends Error {
  constructor(min: number) {
    super(`Give a reason of at least ${min} characters (at most ${ARCHIVE_REASON_MAX_LENGTH}).`);
    this.name = "InvalidArchiveReasonError";
  }
}

/** Trims and validates a mandatory reason. */
export function normaliseArchiveReason(raw: unknown, minLength: number): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < minLength || reason.length > ARCHIVE_REASON_MAX_LENGTH) throw new InvalidArchiveReasonError(minLength);
  return reason;
}

/** Same `SELECT ... FOR UPDATE` as membership-rules' `lockOrganization` (duplicated to avoid an import cycle). */
async function lockOrganization(tx: TenantDb, organizationId: string) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for("update");
  if (!org) throw new OrganizationNotFoundForArchiveError(organizationId);
  return org;
}

export class OrganizationNotFoundForArchiveError extends Error {
  constructor(organizationId: string) {
    super(`Organization ${organizationId} was not found.`);
    this.name = "OrganizationNotFoundForArchiveError";
  }
}

/** Sets the archive columns. Throws if the organization is already archived. Must run inside a transaction. */
export async function applyArchive(tx: TenantDb, organizationId: string, input: { byUserId: string; reason: string }) {
  const org = await lockOrganization(tx, organizationId);
  if (org.archivedAt) throw new OrganizationAlreadyArchivedError();

  const now = new Date();
  const [updated] = await tx
    .update(organizations)
    .set({ archivedAt: now, archivedByUserId: input.byUserId, archiveReason: input.reason, updatedAt: now })
    .where(eq(organizations.id, organizationId))
    .returning();
  return { before: org, after: updated! };
}

/** Clears the archive columns. Throws if the organization is not archived. Must run inside a transaction. */
export async function applyRestore(tx: TenantDb, organizationId: string) {
  const org = await lockOrganization(tx, organizationId);
  if (!org.archivedAt) throw new OrganizationNotArchivedError();

  const [updated] = await tx
    .update(organizations)
    .set({ archivedAt: null, archivedByUserId: null, archiveReason: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning();
  return { before: org, after: updated! };
}

/** One primary-key read. For the few service-level runners (not request hot paths) that act on an organization by id. */
export async function assertOrganizationActive(tx: TenantDb, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ archivedAt: organizations.archivedAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (row?.archivedAt) throw new OrganizationArchivedError(organizationId);
}
