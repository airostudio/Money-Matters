import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  practiceClientLinks,
  practiceMembers,
  practicePartners,
  practiceRoster,
  practiceTasks,
  practices,
  users,
} from "@/db/schema";
import { withUserScope } from "@/db/user-scope";
import { normalizeEmail } from "@/domain/auth/email";
import { PracticeAccess, assertPracticeRole } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import {
  AlreadyPracticeMemberError,
  CannotChangePartnerError,
  LastPartnerError,
  PracticeNameError,
  PracticeStaffFullError,
  PracticeStaffNotFoundError,
  PracticeStaffUserNotFoundError,
  TooManyPracticesError,
} from "./errors";
import { MAX_PRACTICES_PER_USER, MAX_PRACTICE_STAFF, type PracticeActor, type PracticeRole } from "./types";

export interface StaffView {
  userId: string;
  name: string;
  email: string;
  role: PracticeRole;
  status: "ACTIVE" | "REMOVED";
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new PracticeNameError("Practice name is required.");
  if (name.length > 120) throw new PracticeNameError("Practice name must be 120 characters or fewer.");
  return name;
}

function assertRole(role: string): asserts role is PracticeRole {
  if (role !== "PARTNER" && role !== "MANAGER" && role !== "STAFF") {
    throw new PracticeNameError(`"${role}" is not a practice role (PARTNER, MANAGER or STAFF).`);
  }
}

/**
 * Practices and their staff. A practice belongs to no organization: it is
 * created by any registered user, who becomes its first PARTNER, and every
 * method here takes the acting USER and runs in a user-scoped transaction
 * (`withUserScope`). Row-level security (drizzle/0041_*) means a user who is not
 * an active member of a practice cannot read or write any of its rows, even by
 * calling withUserScope directly; the role checks below (`PracticeAccess`) are
 * the finer rules on top of that.
 *
 * Who may do what: PARTNER adds staff, changes roles, renames the practice;
 * anyone may leave. A partner can only be demoted or removed BY THEMSELVES
 * (step down / leave) — the database's partner anchor is own-row-only, which is
 * what keeps the membership policies free of self-recursion — and a practice
 * always keeps at least one partner.
 *
 * Joining a practice grants NO access to any client's books: that needs a real
 * membership in the client organization (docs/security.md section 13).
 */
export const PracticeService = {
  async create(actor: PracticeActor, input: { name: string }) {
    const name = cleanName(input.name);
    return withUserScope(actor.userId, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(practices)
        .where(eq(practices.createdByUserId, actor.userId));
      if (n >= MAX_PRACTICES_PER_USER) throw new TooManyPracticesError();

      const [practice] = await tx.insert(practices).values({ name, createdByUserId: actor.userId }).returning();
      if (!practice) throw new Error("Failed to create practice.");

      // Order matters: the founder's partner anchor first, then their member row (its
      // policy asks for the anchor), then the directory mirror (which asks for both).
      await tx.insert(practicePartners).values({ practiceId: practice.id, userId: actor.userId });
      await tx.insert(practiceMembers).values({
        practiceId: practice.id,
        userId: actor.userId,
        role: "PARTNER",
        status: "ACTIVE",
        invitedByUserId: actor.userId,
      });
      await tx.insert(practiceRoster).values({ practiceId: practice.id, userId: actor.userId, role: "PARTNER", status: "ACTIVE" });

      await PracticeAuditService.record(tx, {
        practiceId: practice.id,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice.created",
        entityType: "Practice",
        entityId: practice.id,
        after: { name },
      });
      return practice;
    });
  },

  /** The practices the user is an ACTIVE member of, with their role in each. */
  async listMine(actor: PracticeActor) {
    return withUserScope(actor.userId, (tx) =>
      tx
        .select({ id: practices.id, name: practices.name, role: practiceMembers.role })
        .from(practiceMembers)
        .innerJoin(practices, eq(practices.id, practiceMembers.practiceId))
        .where(and(eq(practiceMembers.userId, actor.userId), eq(practiceMembers.status, "ACTIVE")))
        .orderBy(asc(practices.name)),
    );
  },

  async get(actor: PracticeActor, practiceId: string) {
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const [practice] = await tx.select().from(practices).where(eq(practices.id, practiceId));
      if (!practice) throw new Error("Practice not found.");
      return { practice, role: ctx.role };
    });
  },

  async rename(actor: PracticeActor, practiceId: string, name: string) {
    const clean = cleanName(name);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "PARTNER", "Renaming the practice");
      const [before] = await tx.select({ name: practices.name }).from(practices).where(eq(practices.id, practiceId));
      await tx.update(practices).set({ name: clean, updatedAt: new Date() }).where(eq(practices.id, practiceId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice.renamed",
        entityType: "Practice",
        entityId: practiceId,
        before: { name: before?.name },
        after: { name: clean },
      });
    });
  },

  /** The colleague directory — every ACTIVE member can read it (it is the assignee list). */
  async listStaff(actor: PracticeActor, practiceId: string, opts: { includeRemoved?: boolean } = {}): Promise<StaffView[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const rows = await tx
        .select({
          userId: practiceRoster.userId,
          name: users.name,
          email: users.email,
          role: practiceRoster.role,
          status: practiceRoster.status,
        })
        .from(practiceRoster)
        .innerJoin(users, eq(users.id, practiceRoster.userId))
        .where(
          and(eq(practiceRoster.practiceId, practiceId), opts.includeRemoved ? undefined : eq(practiceRoster.status, "ACTIVE")),
        )
        .orderBy(asc(users.name));
      return rows;
    });
  },

  /** Adds an EXISTING user (same rule as OrganizationService.addMemberByEmail). Partner only. */
  async addStaffByEmail(actor: PracticeActor, practiceId: string, email: string, role: PracticeRole) {
    assertRole(role);
    const normalized = normalizeEmail(email);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "PARTNER", "Adding staff");
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, normalized));
      if (!user) throw new PracticeStaffUserNotFoundError(normalized);

      const [existing] = await tx
        .select()
        .from(practiceMembers)
        .where(and(eq(practiceMembers.practiceId, practiceId), eq(practiceMembers.userId, user.id)));
      if (existing?.status === "ACTIVE") throw new AlreadyPracticeMemberError();

      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(practiceRoster)
        .where(and(eq(practiceRoster.practiceId, practiceId), eq(practiceRoster.status, "ACTIVE")));
      if (n >= MAX_PRACTICE_STAFF) throw new PracticeStaffFullError();

      if (role === "PARTNER") {
        await tx.insert(practicePartners).values({ practiceId, userId: user.id }).onConflictDoNothing();
      }
      if (existing) {
        await tx
          .update(practiceMembers)
          .set({ status: "ACTIVE", role, invitedByUserId: actor.userId, updatedAt: new Date() })
          .where(eq(practiceMembers.id, existing.id));
      } else {
        await tx.insert(practiceMembers).values({ practiceId, userId: user.id, role, status: "ACTIVE", invitedByUserId: actor.userId });
        await tx.insert(practiceRoster).values({ practiceId, userId: user.id, role, status: "ACTIVE" });
      }

      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice_member.added",
        entityType: "PracticeMember",
        entityId: user.id,
        after: { userId: user.id, role },
        metadata: existing ? { reactivated: true } : undefined,
      });
      return { userId: user.id, role };
    });
  },

  async changeStaffRole(actor: PracticeActor, practiceId: string, userId: string, role: PracticeRole) {
    assertRole(role);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "PARTNER", "Changing a staff role");
      const [target] = await tx
        .select()
        .from(practiceMembers)
        .where(and(eq(practiceMembers.practiceId, practiceId), eq(practiceMembers.userId, userId), eq(practiceMembers.status, "ACTIVE")));
      if (!target) throw new PracticeStaffNotFoundError();
      if (target.role === role) return target;

      const isSelf = userId === actor.userId;
      if (target.role === "PARTNER" && !isSelf) throw new CannotChangePartnerError();
      if (target.role === "PARTNER") await assertAnotherPartner(tx, practiceId, userId);

      if (role === "PARTNER") {
        await tx.insert(practicePartners).values({ practiceId, userId }).onConflictDoNothing();
      }
      await tx.update(practiceMembers).set({ role, updatedAt: new Date() }).where(eq(practiceMembers.id, target.id));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice_member.role_changed",
        entityType: "PracticeMember",
        entityId: userId,
        before: { role: target.role },
        after: { role },
      });
      // Stepping down: drop the partner anchor last, so the audit above still ran as a member.
      if (target.role === "PARTNER") {
        await tx.delete(practicePartners).where(and(eq(practicePartners.practiceId, practiceId), eq(practicePartners.userId, userId)));
      }
      return { ...target, role };
    });
  },

  /** Removes a staff member (partner only), or lets any member leave. Their assignments are cleared. */
  async removeStaff(actor: PracticeActor, practiceId: string, userId: string) {
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const isSelf = userId === actor.userId;
      if (!isSelf) assertPracticeRole(ctx, "PARTNER", "Removing staff");
      const [target] = await tx
        .select()
        .from(practiceMembers)
        .where(and(eq(practiceMembers.practiceId, practiceId), eq(practiceMembers.userId, userId), eq(practiceMembers.status, "ACTIVE")));
      if (!target) throw new PracticeStaffNotFoundError();
      if (target.role === "PARTNER" && !isSelf) throw new CannotChangePartnerError();
      if (target.role === "PARTNER") await assertAnotherPartner(tx, practiceId, userId);

      // Clear their responsibilities while they are still a member (these writes need an active member).
      await tx
        .update(practiceClientLinks)
        .set({ assignedUserId: null, updatedAt: new Date() })
        .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.assignedUserId, userId)));
      await tx
        .update(practiceTasks)
        .set({ assignedUserId: null, updatedAt: new Date() })
        .where(
          and(
            eq(practiceTasks.practiceId, practiceId),
            eq(practiceTasks.assignedUserId, userId),
            isNotNull(practiceTasks.assignedUserId),
            ne(practiceTasks.status, "DONE"),
            ne(practiceTasks.status, "CANCELLED"),
          ),
        );
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: isSelf ? "practice_member.left" : "practice_member.removed",
        entityType: "PracticeMember",
        entityId: userId,
        before: { role: target.role, status: "ACTIVE" },
        after: { status: "REMOVED" },
      });
      await tx
        .update(practiceMembers)
        .set({ status: "REMOVED", updatedAt: new Date() })
        .where(eq(practiceMembers.id, target.id));
      if (target.role === "PARTNER") {
        await tx.delete(practicePartners).where(and(eq(practicePartners.practiceId, practiceId), eq(practicePartners.userId, userId)));
      }
    });
  },
};

async function assertAnotherPartner(tx: Parameters<Parameters<typeof withUserScope>[1]>[0], practiceId: string, excludingUserId: string) {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(practiceRoster)
    .where(
      and(
        eq(practiceRoster.practiceId, practiceId),
        eq(practiceRoster.role, "PARTNER"),
        eq(practiceRoster.status, "ACTIVE"),
        ne(practiceRoster.userId, excludingUserId),
      ),
    );
  if (n < 1) throw new LastPartnerError();
}
