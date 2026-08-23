import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { organizationMemberships, organizations, users } from "@/db/schema";
import { AccountService } from "@/domain/accounts/account-service";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";

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

export class MembershipNotFoundError extends Error {
  constructor(membershipId: string) {
    super(`Membership ${membershipId} was not found in this organization.`);
    this.name = "MembershipNotFoundError";
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
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) throw new UserNotFoundError(email);

    return withTenant(actor.organizationId, async (tx) => {
      const [membership] = await tx
        .insert(organizationMemberships)
        .values({ organizationId: actor.organizationId, userId: user.id, role })
        .returning();

      await AuditService.record(tx, actor, {
        action: "membership.created",
        entityType: "OrganizationMembership",
        entityId: membership!.id,
        after: { userId: user.id, role },
      });

      return membership;
    });
  },

  async updateMemberRole(actor: Actor, membershipId: string, role: MembershipRole) {
    assertPermission(actor, "membership:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, actor.organizationId),
          ),
        );
      if (!existing) throw new MembershipNotFoundError(membershipId);

      const [updated] = await tx
        .update(organizationMemberships)
        .set({ role, updatedAt: new Date() })
        .where(eq(organizationMemberships.id, membershipId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "membership.role_changed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { role: existing.role },
        after: { role },
      });

      return updated;
    });
  },

  async removeMember(actor: Actor, membershipId: string) {
    assertPermission(actor, "membership:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, actor.organizationId),
          ),
        );
      if (!existing) throw new MembershipNotFoundError(membershipId);

      await tx
        .update(organizationMemberships)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(organizationMemberships.id, membershipId));

      await AuditService.record(tx, actor, {
        action: "membership.removed",
        entityType: "OrganizationMembership",
        entityId: membershipId,
        before: { isActive: true },
        after: { isActive: false },
      });
    });
  },
};
