import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { organizationInviteIndex, organizationInvites, organizationMemberships, users } from "@/db/schema";
import { AuthThrottle } from "@/domain/api/auth-throttle";
import { AuditService } from "@/domain/audit/audit-service";
import { normalizeEmail } from "@/domain/auth/email";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleNeedsWriteConfirmation } from "@/domain/permissions/role-info";
import type { MembershipRole } from "@/domain/permissions/roles";
import { OrganizationArchivedError } from "./archive-rules";
import { generateInviteCode, hashInviteCode, normaliseInviteCode } from "./invite-code";
import {
  INVITE_REDEEM_THROTTLE_MAX_FAILURES,
  INVITE_REDEEM_THROTTLE_WINDOW_MS,
  INVITE_TTL_DAYS,
  MAX_PENDING_INVITES_PER_ORG,
} from "./limits";
import { AlreadyMemberError, WriteAccessConfirmationRequiredError, addMembership, assertValidRole, lockOrganization } from "./membership-rules";

/**
 * Invite CODES (docs/security.md section 17). The platform has no email delivery and no email verification, so an
 * invite bound only to an email address would be unsafe - anyone could register that address first and inherit
 * access. Instead an OWNER/ADMINISTRATOR creates an invite and receives a high-entropy single-use secret code, shown
 * ONCE, to pass to the invitee out of band. Redeeming it requires BOTH the code AND an account registered with the
 * invited email.
 *
 * The code is stored only as a SHA-256 hash in `organization_invite_index` (the narrow non-tenant lookup that lets a
 * not-yet-member find the invite); everything else - email, role, expiry, state - lives in the RLS-protected
 * `organization_invites` row. Management (create / list / revoke) is human-only: an API key, AI agent or system
 * actor is refused even with a role that holds `membership:manage`.
 */

export class InviteInvalidError extends Error {
  constructor() {
    // One message for every reason - unknown, expired, revoked, used, wrong email, archived company - so a guess can
    // learn nothing about which companies, emails or invites exist.
    super("That invite code is invalid or has expired. Check it with the person who sent it, or ask them for a new one.");
    this.name = "InviteInvalidError";
  }
}

export class InviteThrottledError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many incorrect invite codes. Please wait about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute(s) and try again.`);
    this.name = "InviteThrottledError";
  }
}

export class PendingInviteLimitError extends Error {
  constructor(public readonly limit: number = MAX_PENDING_INVITES_PER_ORG) {
    super(`This company already has ${limit} pending invites. Revoke one you no longer need, or wait for it to expire or be used.`);
    this.name = "PendingInviteLimitError";
  }
}

export class InviteEmailInvalidError extends Error {
  constructor() {
    super("Enter a valid email address for the invite.");
    this.name = "InviteEmailInvalidError";
  }
}

export class InviteNotFoundError extends Error {
  constructor() {
    super("That invite was not found in this company.");
    this.name = "InviteNotFoundError";
  }
}

export class InviteNotPendingError extends Error {
  constructor(state: "used" | "revoked" | "expired") {
    super(`That invite has already been ${state === "expired" ? "expired" : state}, so it cannot be revoked.`);
    this.name = "InviteNotPendingError";
  }
}

/** Per-instance, best-effort failed-redemption throttle (docs/security.md section 17). Keys: `user:<id>` and `ip:<address>`. */
export const inviteRedeemThrottle = new AuthThrottle(INVITE_REDEEM_THROTTLE_MAX_FAILURES, INVITE_REDEEM_THROTTLE_WINDOW_MS);

export type InviteStatus = "PENDING" | "USED" | "REVOKED" | "EXPIRED";

export function inviteStatus(row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InviteStatus {
  if (row.usedAt) return "USED";
  if (row.revokedAt) return "REVOKED";
  if (row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "PENDING";
}

export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Management is human-only AND needs `membership:manage`. */
export function assertHumanInviteManager(actor: Actor): void {
  assertPermission(actor, "membership:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("membership:manage", actor.role);
}

export interface InviteSummary {
  id: string;
  email: string;
  role: MembershipRole;
  codePrefix: string;
  status: InviteStatus;
  createdAt: Date;
  expiresAt: Date;
  createdByName: string | null;
}

export interface RedeemOptions {
  /** Extra throttle keys beside the person themself, e.g. `ip:203.0.113.9`. */
  clientKeys?: string[];
  throttle?: AuthThrottle;
  now?: Date;
  /** Where the redemption came from, recorded in the audit row. */
  via?: "chooser" | "registration";
}

export const InviteService = {
  /**
   * Creates an invite and returns the code ONCE. `options.confirmWriteAccess` is REQUIRED (unlike the add-by-email
   * path there is no trusted caller that omits it): granting a role that can change financial data needs the explicit
   * confirmation, enforced here, not in the form.
   */
  async create(
    actor: Actor,
    input: { email: string; role: string },
    options: { confirmWriteAccess: boolean },
    now: Date = new Date(),
  ) {
    assertHumanInviteManager(actor);
    assertValidRole(input.role);
    const role: MembershipRole = input.role;
    if (roleNeedsWriteConfirmation(role) && options?.confirmWriteAccess !== true) {
      throw new WriteAccessConfirmationRequiredError(role);
    }
    const email = normalizeEmail(input.email ?? "");
    if (!EMAIL_PATTERN.test(email) || email.length > 320) throw new InviteEmailInvalidError();

    const generated = generateInviteCode();
    const expiresAt = inviteExpiry(now);

    const invite = await withTenant(actor.organizationId, async (tx) => {
      // Serialises invite creation (and the pending cap) with membership changes and archive for this company.
      const org = await lockOrganization(tx, actor.organizationId);
      if (org.archivedAt) throw new OrganizationArchivedError(org.id);

      const [existingMember] = await tx
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(
          and(
            eq(organizationMemberships.organizationId, actor.organizationId),
            eq(organizationMemberships.isActive, true),
            eq(users.email, email),
          ),
        );
      if (existingMember) throw new AlreadyMemberError();

      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(organizationInvites)
        .where(
          and(
            eq(organizationInvites.organizationId, actor.organizationId),
            isNull(organizationInvites.usedAt),
            isNull(organizationInvites.revokedAt),
            gt(organizationInvites.expiresAt, now),
          ),
        );
      if ((pending?.n ?? 0) >= MAX_PENDING_INVITES_PER_ORG) throw new PendingInviteLimitError();

      const [row] = await tx
        .insert(organizationInvites)
        .values({
          organizationId: actor.organizationId,
          email,
          role,
          codePrefix: generated.prefix,
          invitedByUserId: actor.userId,
          createdAt: now,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error("Failed to create the invite.");

      await tx.insert(organizationInviteIndex).values({ id: row.id, organizationId: actor.organizationId, codeHash: generated.codeHash });

      // Never the code (nor its hash): only the invite's identity, target and validity.
      await AuditService.record(tx, actor, {
        action: "organization_invite.created",
        entityType: "OrganizationInvite",
        entityId: row.id,
        after: { email, role, codePrefix: generated.prefix, expiresAt },
      });
      return row;
    });

    return { invite, code: generated.code };
  },

  /** Recent invites for the settings page, pending first. Never includes any code. */
  async list(actor: Actor, now: Date = new Date()): Promise<InviteSummary[]> {
    assertHumanInviteManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ invite: organizationInvites, createdByName: users.name })
        .from(organizationInvites)
        .leftJoin(users, eq(users.id, organizationInvites.invitedByUserId))
        .where(eq(organizationInvites.organizationId, actor.organizationId))
        .orderBy(desc(organizationInvites.createdAt))
        .limit(50);
      const mapped = rows.map(
        (r): InviteSummary => ({
          id: r.invite.id,
          email: r.invite.email,
          role: r.invite.role,
          codePrefix: r.invite.codePrefix,
          status: inviteStatus(r.invite, now),
          createdAt: r.invite.createdAt,
          expiresAt: r.invite.expiresAt,
          createdByName: r.createdByName,
        }),
      );
      return [...mapped.filter((m) => m.status === "PENDING"), ...mapped.filter((m) => m.status !== "PENDING")];
    });
  },

  async revoke(actor: Actor, inviteId: string, now: Date = new Date()) {
    assertHumanInviteManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      await lockOrganization(tx, actor.organizationId);
      const [invite] = await tx
        .select()
        .from(organizationInvites)
        .where(and(eq(organizationInvites.id, inviteId), eq(organizationInvites.organizationId, actor.organizationId)))
        .for("update");
      if (!invite) throw new InviteNotFoundError();
      const status = inviteStatus(invite, now);
      if (status === "USED") throw new InviteNotPendingError("used");
      if (status === "REVOKED") throw new InviteNotPendingError("revoked");

      await tx
        .update(organizationInvites)
        .set({ revokedAt: now, revokedByUserId: actor.userId })
        .where(eq(organizationInvites.id, inviteId));
      await AuditService.record(tx, actor, {
        action: "organization_invite.revoked",
        entityType: "OrganizationInvite",
        entityId: inviteId,
        before: { status },
        after: { status: "REVOKED" },
        metadata: { email: invite.email, codePrefix: invite.codePrefix },
      });
    });
  },

  /**
   * Redeems a code for an existing account. Every refusal that could reveal something about a company, email or invite
   * is the ONE generic `InviteInvalidError`; the only specific messages are ones the redeemer is already entitled to
   * (the company is at its seat limit - the invite stays valid, they are already a member) or that concern only them
   * (throttled). Each failed guess is recorded against the person and their address; success clears them.
   */
  async redeem(userId: string, rawCode: string, options: RedeemOptions = {}) {
    const now = options.now ?? new Date();
    const throttle = options.throttle ?? inviteRedeemThrottle;
    const keys = [`user:${userId}`, ...(options.clientKeys ?? [])];

    const wait = Math.max(...keys.map((k) => throttle.retryAfterSeconds(k, now.getTime())));
    if (wait > 0) throw new InviteThrottledError(wait);
    const fail = (): never => {
      for (const k of keys) throttle.recordFailure(k, now.getTime());
      throw new InviteInvalidError();
    };

    const code = normaliseInviteCode(rawCode);
    if (!code) return fail();

    const [indexed] = await db
      .select({ id: organizationInviteIndex.id, organizationId: organizationInviteIndex.organizationId })
      .from(organizationInviteIndex)
      .where(eq(organizationInviteIndex.codeHash, hashInviteCode(code)));
    if (!indexed) return fail();

    const [user] = await db.select({ id: users.id, email: users.email, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
    if (!user || user.disabledAt) return fail();

    try {
      const joined = await withTenant(indexed.organizationId, async (tx) => {
        // Same lock order as every membership change: organization row first. It serialises two simultaneous
        // redemptions of one code (the second sees `used_at` and is refused) and the seat check below.
        const org = await lockOrganization(tx, indexed.organizationId);
        if (org.archivedAt) throw new InviteInvalidError();

        const [invite] = await tx
          .select()
          .from(organizationInvites)
          .where(and(eq(organizationInvites.id, indexed.id), eq(organizationInvites.organizationId, indexed.organizationId)))
          .for("update");
        if (!invite || inviteStatus(invite, now) !== "PENDING") throw new InviteInvalidError();
        if (invite.email !== normalizeEmail(user.email)) throw new InviteInvalidError();

        // SeatLimitReachedError / AlreadyMemberError propagate (rolling back, so the invite is NOT consumed).
        const { membership, reactivated } = await addMembership(tx, org.id, user.id, invite.role);

        await tx.update(organizationInvites).set({ usedAt: now, usedByUserId: user.id }).where(eq(organizationInvites.id, invite.id));

        const actor: Actor = { userId: user.id, organizationId: org.id, role: invite.role };
        await AuditService.record(tx, actor, {
          action: "membership.created",
          entityType: "OrganizationMembership",
          entityId: membership.id,
          after: { userId: user.id, role: invite.role },
          metadata: { viaInviteId: invite.id, ...(reactivated ? { reactivated: true } : {}) },
        });
        await AuditService.record(tx, actor, {
          action: "organization_invite.redeemed",
          entityType: "OrganizationInvite",
          entityId: invite.id,
          before: { status: "PENDING" },
          after: { status: "USED", usedByUserId: user.id, role: invite.role },
          metadata: { codePrefix: invite.codePrefix, via: options.via ?? "chooser" },
        });
        return { organization: { id: org.id, slug: org.slug, name: org.name }, role: invite.role };
      });
      // Only the person's own counter is cleared: a shared address (an office NAT) must not be reset by one member's success.
      throttle.recordSuccess(keys[0]!);
      return joined;
    } catch (error) {
      if (error instanceof InviteInvalidError) return fail();
      throw error;
    }
  },
};
