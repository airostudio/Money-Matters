import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { organizationMemberships, organizations, users } from "@/db/schema";
import { AccountService } from "@/domain/accounts/account-service";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { ROLE_PERMISSIONS, type MembershipRole } from "@/domain/permissions/roles";
import { roleNeedsWriteConfirmation } from "@/domain/permissions/role-info";
import { normalizeEmail } from "@/domain/auth/email";
import { AuthThrottle } from "@/domain/api/auth-throttle";
import { slugify } from "@/lib/utils";
import {
  COMPANY_CREATE_THROTTLE_MAX,
  COMPANY_CREATE_THROTTLE_WINDOW_MS,
  MAX_OWNED_ACTIVE_COMPANIES,
} from "./limits";
import {
  OrganizationRecordNotFoundError,
  WriteAccessConfirmationRequiredError,
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
  WriteAccessConfirmationRequiredError,
} from "./membership-rules";

/**
 * Top-level URL segments that exist as real routes. An organization slug equal
 * to one of these would be unreachable (the static route wins over `[orgSlug]`)
 * — and "admin" in particular must never be claimable by a customer.
 */
const RESERVED_SLUGS = new Set(["admin", "app", "api", "login", "register", "_next", "practice", "oauth"]);

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Organization slug "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

export class CompanyLimitReachedError extends Error {
  constructor(public readonly limit: number = MAX_OWNED_ACTIVE_COMPANIES) {
    super(
      `You already own ${limit} active companies, which is the most one person can own. Archive a company you no longer ` +
        `use (it can be restored later, and archived companies do not count), or ask the platform administrator.`,
    );
    this.name = "CompanyLimitReachedError";
  }
}

export class CreateCompanyThrottledError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`You have created several companies in a short time. Please wait about ${Math.ceil(retryAfterSeconds / 60)} minute(s) and try again.`);
    this.name = "CreateCompanyThrottledError";
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

/** Per-instance, best-effort (docs/security.md section 17): counts create-another-company ATTEMPTS per person. */
export const companyCreateThrottle = new AuthThrottle(COMPANY_CREATE_THROTTLE_MAX, COMPANY_CREATE_THROTTLE_WINDOW_MS);

function isSlugUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const code = e?.cause?.code ?? e?.code;
  const constraint = e?.cause?.constraint ?? e?.constraint;
  return code === "23505" && constraint === "organizations_slug_unique";
}

export interface CreateOrganizationOptions {
  /** Enforce the per-person cap on ACTIVE owned companies (create-another-company). Registration does not (a new user owns none). */
  enforceCompanyLimit?: boolean;
  /** Extra metadata for the `organization.created` audit row. */
  auditMetadata?: Record<string, unknown>;
}

export interface MemberGrantOptions {
  /** The person granting access ticked "I understand this person will be able to edit financial data". */
  confirmWriteAccess: boolean;
}

function assertWriteAccessConfirmed(role: MembershipRole, options: MemberGrantOptions | undefined): void {
  if (!options) return;
  // An unknown role string must fail as InvalidRoleError (raised by the
  // membership rules), not be misclassified here.
  if (!(role in ROLE_PERMISSIONS)) return;
  if (roleNeedsWriteConfirmation(role) && options.confirmWriteAccess !== true) {
    throw new WriteAccessConfirmationRequiredError(role);
  }
}

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
  async createWithOwner(ownerUserId: string, input: CreateOrganizationInput, options: CreateOrganizationOptions = {}) {
    if (RESERVED_SLUGS.has(input.slug)) throw new SlugTakenError(input.slug);

    const org = await db
      .transaction(async (tx) => {
        if (options.enforceCompanyLimit) {
          // Serialise this person's concurrent creations on their own user row, so two simultaneous requests cannot
          // both pass the cap check. (Lock order: user row, then nothing else - the new organization is not visible yet.)
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update");
          const [owned] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(organizationMemberships)
            .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
            .where(
              and(
                eq(organizationMemberships.userId, ownerUserId),
                eq(organizationMemberships.role, "OWNER"),
                eq(organizationMemberships.isActive, true),
                isNull(organizations.archivedAt),
              ),
            );
          if ((owned?.n ?? 0) >= MAX_OWNED_ACTIVE_COMPANIES) throw new CompanyLimitReachedError();
        }

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
      })
      .catch((error: unknown) => {
        // Two registrations racing for the same slug: the unique index decides; report it like the pre-check does.
        if (isSlugUniqueViolation(error)) throw new SlugTakenError(input.slug);
        throw error;
      });

    const ownerActor: Actor = { userId: ownerUserId, organizationId: org.id, role: "OWNER" };

    await withTenant(org.id, (tx) =>
      AuditService.record(tx, ownerActor, {
        action: "organization.created",
        entityType: "Organization",
        entityId: org.id,
        after: org,
        metadata: options.auditMetadata,
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

  /**
   * The user's ACTIVE membership of an organization, or null - and null also when the organization is ARCHIVED
   * (docs/security.md section 17): every path that turns a membership into an Actor goes through here, so an
   * archived company yields no Actor anywhere unless a caller explicitly asks for `includeArchived` (only the
   * "this company is archived" page and the owner's restore do). One query either way (the organizations join
   * is what carries the flag).
   */
  async getMembership(userId: string, organizationId: string, options: { includeArchived?: boolean } = {}) {
    const found = await OrganizationService.getMembershipWithState(userId, organizationId);
    if (!found) return null;
    if (found.archivedAt && !options.includeArchived) return null;
    return found.membership;
  },

  /** The membership AND whether the organization is archived, in one query - what the session choke point needs to tell "not yours" from "archived". */
  async getMembershipWithState(userId: string, organizationId: string) {
    const [row] = await db
      .select({ membership: getTableColumns(organizationMemberships), archivedAt: organizations.archivedAt })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.isActive, true),
        ),
      );
    return row ?? null;
  },

  /**
   * A user's own ACTIVE memberships in non-archived organizations - for the org switcher, practice and consolidation
   * access maps. Archived organizations are excluded here, which is what makes them "unavailable" to practice
   * dashboards and consolidation groups without a per-feature check. Never scoped by RLS (a user's identity spans orgs
   * by design), enforced by the userId filter itself.
   */
  async listMembershipsForUser(userId: string) {
    return db
      .select({
        membershipId: organizationMemberships.id,
        role: organizationMemberships.role,
        organization: organizations,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.isActive, true),
          isNull(organizations.archivedAt),
        ),
      );
  },

  /** ONE query for the company chooser: every active membership, archived or not (the page splits them). */
  async listAllMembershipsForUser(userId: string) {
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

  /**
   * Creates a company for an EXISTING signed-in user ("create another company"): same bootstrap as registration (this
   * person becomes OWNER in seat 1, starter system accounts, `organization.created` audit row), with the per-person cap
   * on ACTIVE owned companies and a best-effort attempt throttle. The slug is generated exactly as registration does.
   */
  async createAdditionalCompany(
    userId: string,
    input: { name: string; baseCurrency?: string; country?: string },
    deps: { throttle?: AuthThrottle; now?: number } = {},
  ) {
    const throttle = deps.throttle ?? companyCreateThrottle;
    const now = deps.now ?? Date.now();
    const wait = throttle.retryAfterSeconds(`create:${userId}`, now);
    if (wait > 0) throw new CreateCompanyThrottledError(wait);
    throttle.recordFailure(`create:${userId}`, now); // counts attempts, not failures

    return OrganizationService.createWithUniqueSlug(userId, input, {
      enforceCompanyLimit: true,
      auditMetadata: { createdFromExistingAccount: true },
    });
  },

  /**
   * THE slug-generation/collision logic registration and create-another-company share: slugify the name (falling back
   * to "business"), and on a collision - or a reserved slug such as "admin" - retry with a short random suffix.
   * Archived organizations keep their slug, so a slug is never reused while its company exists.
   */
  async createWithUniqueSlug(
    ownerUserId: string,
    input: { name: string; baseCurrency?: string; country?: string; industry?: string },
    options: CreateOrganizationOptions = {},
  ) {
    const baseSlug = slugify(input.name) || "business";
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        return await OrganizationService.createWithOwner(ownerUserId, { ...input, slug }, options);
      } catch (error) {
        if (error instanceof SlugTakenError) continue;
        throw error;
      }
    }
    throw new SlugTakenError(baseSlug);
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

  /**
   * Adds an existing user by email.
   *
   * `options` is the interactive path's explicit-confirmation contract: when a
   * caller supplies it (the settings page always does), granting a role that
   * can change financial data (`roleNeedsWriteConfirmation` - every role but
   * the read-only ones, OWNER and ADMINISTRATOR included) requires
   * `confirmWriteAccess: true`, else `WriteAccessConfirmationRequiredError`.
   * Calls that omit `options` entirely are trusted server-side callers (seed
   * scripts, test fixtures, the practice staff service) and keep their original
   * behaviour; nothing reachable from a browser omits it.
   */
  async addMemberByEmail(actor: Actor, email: string, role: MembershipRole, options?: MemberGrantOptions) {
    assertPermission(actor, "membership:manage");
    assertWriteAccessConfirmed(role, options);
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

  /** Changes a member's role. `options` works exactly as in `addMemberByEmail`. */
  async updateMemberRole(actor: Actor, membershipId: string, role: MembershipRole, options?: MemberGrantOptions) {
    assertPermission(actor, "membership:manage");
    assertWriteAccessConfirmed(role, options);
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
      .select({ seatLimit: organizations.seatLimit, planTier: organizations.planTier, archivedAt: organizations.archivedAt })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) throw new OrganizationRecordNotFoundError(organizationId);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
    const seatsUsed = row?.n ?? 0;
    return { seatsUsed, seatLimit: org.seatLimit, planTier: org.planTier, isFull: seatsUsed >= org.seatLimit, archived: org.archivedAt !== null };
  },
};
