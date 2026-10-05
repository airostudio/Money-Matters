import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { organizationMemberships, organizations, users } from "@/db/schema";
import { AccountService } from "@/domain/accounts/account-service";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";
import { normalizeEmail } from "@/domain/auth/email";
import {
  OrganizationRecordNotFoundError,
  addMembership,
  changeMembershipRole,
  deactivateMembership,
} from "./membership-rules";

export {
  AlreadyMemberError,
  InvalidRoleError,
  LastOwnerError,
  MembershipNotFoundError,
  SeatLimitReachedError,
} from "./membership-rules";

/**
 * Top-level URL segments that exist as real routes. An organization slug equal
 * to one of these would be unreachable (the static route wins over `[orgSlug]`)
 * — and "admin" in particular must never be claimable by a customer.
 */
const RESERVED_SLUGS = new Set(["admin", "app", "api", "login", "register", "_next", "practice"]);

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Organization slug "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

export class UserNotFoundError extends Error {
  constructor(email: string) {
    super(`No user with email "${email}" exists yet — they must sign up first.`);
    this.name = "UserNotFoundError";
  }
}

export interface CreateOrganizationInput {
  slug: string;
  name: string;
  baseCurrency?: string;
  country?: string;
  industry?: string;
}

/**
 * System accounts every new organization starts with. Kept deliberately
 * minimal for Phase 1 — see docs/accounting-engine.md §2. Onboarding
 * (master spec §60) will let the user pick a fuller starter chart of
 * accounts in a later phase.
 */
const STARTER_SYSTEM_ACCOUNTS = [
  { code: "3900", name: "Retained Earnings", type: "EQUITY" as const },
  { code: "3000", name: "Opening Balance Equity", type: "EQUITY" as const },
];

export const OrganizationService = {
  /**
   * Bootstraps a brand-new organization: the org row, an OWNER membership
   * for the creating user, and the minimal starter chart of accounts.
   *
   * Note on transactional scope: the org + membership insert is one atomic
   * transaction; the starter accounts are then created via
   * AccountService.create (each its own transaction) using a freshly
   * legitimate OWNER Actor. This keeps each domain service's transaction
   * boundary self-contained rather than nesting transactions across
   * services. If a starter-account insert fails, the organization still
   * exists with an incomplete chart of accounts — acceptable for Phase 1
   * since account creation is idempotent/retryable and the failure would
   * surface immediately during onboarding, not silently later.
   */
  async createWithOwner(ownerUserId: string, input: CreateOrganizationInput) {
    if (RESERVED_SLUGS.has(input.slug)) throw new SlugTakenError(input.slug);

    const org = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, input.slug));
      if (existing) throw new SlugTakenError(input.slug);

      const [created] = await tx
        .insert(organizations)
        .values({
          slug: input.slug,
          name: input.name,
          baseCurrency: input.baseCurrency ?? "AUD",
          country: input.country ?? "AU",
          industry: input.industry ?? null,
        })
        .returning();
      if (!created) throw new Error("Failed to create organization.");

      await tx.insert(organizationMemberships).values({
        organizationId: created.id,
        userId: ownerUserId,
        role: "OWNER",
      });

      return created;
    });

    const ownerActor: Actor = { userId: ownerUserId, organizationId: org.id, role: "OWNER" };

    await withTenant(org.id, (tx) =>
      AuditService.record(tx, ownerActor, {
        action: "organization.created",
        entityType: "Organization",
        entityId: org.id,
        after: org,
      }),
    );

    for (const starter of STARTER_SYSTEM_ACCOUNTS) {
      await AccountService.create(
        ownerActor,
        { code: starter.code, name: starter.name, type: starter.type, currency: org.baseCurrency },
        { isSystemAccount: true },
      );
    }

    return org;
  },

  async getBySlug(slug: string) {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return org ?? null;
  },

  async getMembership(userId: string, organizationId: string) {
    const [membership] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.isActive, true),
        ),
      );
    return membership ?? null;
  },

  /** A user's own memberships, for the org switcher — never scoped by RLS (a user's identity spans orgs by design), enforced by the userId filter itself. */
  async listMembershipsForUser(userId: string) {
    return db
      .select({
        membershipId: organizationMemberships.id,
        role: organizationMemberships.role,
        organization: organizations,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.isActive, true)));
  },

  async listMembers(actor: Actor) {
    assertPermission(actor, "membership:manage");
    return db
      .select({
        membershipId: organizationMemberships.id,
        role: organizationMemberships.role,
        isActive: organizationMemberships.isActive,
        userId: users.id,
        name: users.name,
        email: users.email,
      })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(eq(organizationMemberships.organizationId, actor.organizationId));
  },

  async addMemberByEmail(actor: Actor, email: string, role: MembershipRole) {
    assertPermission(actor, "membership:manage");
    const normalized = normalizeEmail(email);

    return withTenant(actor.organizationId, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.email, normalized));
      if (!user) throw new UserNotFoundError(normalized);

      // Seat limit + duplicate checks run under a row lock on the organization
      // (membership-rules.ts), so concurrent adds cannot overshoot the limit.
      const { membership, reactivated } = await addMembership(tx, actor.organizationId, user.id, role);

      await AuditService.record(tx, actor, {
        action: "membership.created",
        entityType: "OrganizationMembership",
        entityId: membership.id,
        after: { userId: user.id, role },
        metadata: reactivated ? { reactivated: true } : undefined,
      });

      return membership;
    });
  },

  async updateMemberRole(actor: Actor, membershipId: string, role: MembershipRole) {
    assertPermission(actor, "membership:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const { before, after } = await changeMembershipRole(tx, actor.organizationId, membershipId, role);

      await AuditService.record(tx, actor, {
        action: "membership.role_changed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { role: before.role },
        after: { role: after.role },
      });

      return after;
    });
  },

  async removeMember(actor: Actor, membershipId: string) {
    assertPermission(actor, "membership:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await deactivateMembership(tx, actor.organizationId, membershipId);

      await AuditService.record(tx, actor, {
        action: "membership.removed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { isActive: true },
        after: { isActive: false },
      });
    });
  },

  /** Seats used vs allowed — what the settings page shows next to the add-member control. */
  async getSeatUsage(organizationId: string) {
    const [org] = await db
      .select({ seatLimit: organizations.seatLimit, planTier: organizations.planTier })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) throw new OrganizationRecordNotFoundError(organizationId);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
    const seatsUsed = row?.n ?? 0;
    return { seatsUsed, seatLimit: org.seatLimit, planTier: org.planTier, isFull: seatsUsed >= org.seatLimit };
  },
};
