import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { auditLogs, organizationInviteIndex, organizationInvites, organizationMemberships, organizations, users } from "@/db/schema";
import { UserService } from "@/domain/auth/user-service";
import { AuthThrottle } from "@/domain/api/auth-throttle";
import { OrganizationService, SeatLimitReachedError } from "@/domain/organizations/organization-service";
import { AlreadyMemberError, WriteAccessConfirmationRequiredError } from "@/domain/organizations/membership-rules";
import { OrganizationLifecycleService } from "@/domain/organizations/lifecycle-service";
import {
  InviteInvalidError,
  InviteNotFoundError,
  InviteNotPendingError,
  InviteService,
  InviteThrottledError,
  PendingInviteLimitError,
  inviteRedeemThrottle,
} from "@/domain/organizations/invite-service";
import { hashInviteCode } from "@/domain/organizations/invite-code";
import { MAX_PENDING_INVITES_PER_ORG } from "@/domain/organizations/limits";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";

let counter = 0;
async function register(email: string) {
  counter += 1;
  return UserService.register({ email, name: `Person ${counter}`, password: "password123" });
}

const confirm = { confirmWriteAccess: true };
const noConfirm = { confirmWriteAccess: false };

async function auditRows(organizationId: string) {
  return withTenant(organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, organizationId)));
}
async function inviteRow(organizationId: string, id: string) {
  return withTenant(organizationId, async (tx) => (await tx.select().from(organizationInvites).where(eq(organizationInvites.id, id)))[0]!);
}
async function activeMembers(organizationId: string) {
  return db
    .select()
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
}

describe("Invite codes: create, list, revoke, redeem", () => {
  let org: Awaited<ReturnType<typeof createTestOrg>>;

  afterAll(closeTestPools);

  beforeEach(async () => {
    await resetDatabase();
    inviteRedeemThrottle.clear();
    // The real default: 2 seats (the owner + one more), so the full-company cases are the real ones.
    org = await createTestOrg("invites", { seatLimit: 2 });
  });

  describe("creating an invite", () => {
    it("OWNER and ADMINISTRATOR can; the code is returned once, in the right format, and expires in 7 days", async () => {
      const now = new Date("2026-06-01T00:00:00Z");
      const { invite, code } = await InviteService.create(org.owner, { email: "  New.Person@Example.test ", role: "READ_ONLY" }, noConfirm, now);
      expect(code).toMatch(/^mmj_[a-z2-7]{32}$/);
      expect(invite.email).toBe("new.person@example.test");
      expect(invite.role).toBe("READ_ONLY");
      expect(invite.codePrefix).toBe(code.slice(0, 10));
      expect(invite.expiresAt.toISOString()).toBe("2026-06-08T00:00:00.000Z");

      const admin = actorWithRole(org.owner, "ADMINISTRATOR");
      const second = await InviteService.create(admin, { email: "second@example.test", role: "READ_ONLY" }, noConfirm);
      expect(second.code).not.toBe(code);
    });

    it("refuses people without membership:manage, and every non-human actor even with the OWNER role", async () => {
      for (const role of ["ACCOUNTANT", "BOOKKEEPER", "READ_ONLY", "EMPLOYEE"] as const) {
        await expect(InviteService.create(actorWithRole(org.owner, role), { email: "x@example.test", role: "READ_ONLY" }, noConfirm), role).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      for (const type of ["API", "AI", "SYSTEM"] as const) {
        const nonHuman: Actor = { ...org.owner, type };
        await expect(InviteService.create(nonHuman, { email: "x@example.test", role: "READ_ONLY" }, noConfirm), type).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(InviteService.list(nonHuman), type).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(InviteService.revoke(nonHuman, "00000000-0000-4000-8000-000000000000"), type).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      expect(await db.select().from(organizationInvites)).toHaveLength(0);
    });

    it("a role that can change financial data needs the explicit confirmation, enforced at creation; READ_ONLY does not", async () => {
      for (const role of ["OWNER", "ADMINISTRATOR", "ACCOUNTANT", "BOOKKEEPER"] as const) {
        await expect(InviteService.create(org.owner, { email: "w@example.test", role }, noConfirm), role).rejects.toBeInstanceOf(WriteAccessConfirmationRequiredError);
      }
      expect(await db.select().from(organizationInvites)).toHaveLength(0);
      const ok = await InviteService.create(org.owner, { email: "w@example.test", role: "BOOKKEEPER" }, confirm);
      expect(ok.invite.role).toBe("BOOKKEEPER");
      await expect(InviteService.create(org.owner, { email: "r@example.test", role: "READ_ONLY" }, noConfirm)).resolves.toBeTruthy();
      // Not even a missing options object bypasses it.
      await expect(InviteService.create(org.owner, { email: "z@example.test", role: "OWNER" }, undefined as never)).rejects.toBeInstanceOf(WriteAccessConfirmationRequiredError);
    });

    it("rejects an invalid role, a malformed email, and an email that is already an active member", async () => {
      await expect(InviteService.create(org.owner, { email: "x@example.test", role: "SUPERUSER" }, confirm)).rejects.toThrow(/not a valid membership role/);
      await expect(InviteService.create(org.owner, { email: "not-an-email", role: "READ_ONLY" }, noConfirm)).rejects.toThrow(/valid email/);
      const ownerEmail = await emailOf(org.owner.userId);
      await expect(InviteService.create(org.owner, { email: ownerEmail.toUpperCase(), role: "READ_ONLY" }, noConfirm)).rejects.toBeInstanceOf(AlreadyMemberError);
    });

    it("caps pending invites per organization; used, revoked and expired ones do not count", async () => {
      const t0 = new Date("2026-06-01T00:00:00Z");
      const created: string[] = [];
      for (let i = 0; i < MAX_PENDING_INVITES_PER_ORG; i++) {
        created.push((await InviteService.create(org.owner, { email: `p${i}@example.test`, role: "READ_ONLY" }, noConfirm, t0)).invite.id);
      }
      await expect(InviteService.create(org.owner, { email: "one-too-many@example.test", role: "READ_ONLY" }, noConfirm, t0)).rejects.toBeInstanceOf(PendingInviteLimitError);

      await InviteService.revoke(org.owner, created[0]!, t0);
      await expect(InviteService.create(org.owner, { email: "after-revoke@example.test", role: "READ_ONLY" }, noConfirm, t0)).resolves.toBeTruthy();
      await expect(InviteService.create(org.owner, { email: "full-again@example.test", role: "READ_ONLY" }, noConfirm, t0)).rejects.toBeInstanceOf(PendingInviteLimitError);

      // A week later the original nine have expired and no longer count.
      const later = new Date(t0.getTime() + 8 * 86_400_000);
      await expect(InviteService.create(org.owner, { email: "after-expiry@example.test", role: "READ_ONLY" }, noConfirm, later)).resolves.toBeTruthy();
    });

    it("lists invites (pending first) with status, creator and prefix - never a code", async () => {
      const t0 = new Date("2026-06-01T00:00:00Z");
      const a = await InviteService.create(org.owner, { email: "a@example.test", role: "READ_ONLY" }, noConfirm, t0);
      const b = await InviteService.create(org.owner, { email: "b@example.test", role: "READ_ONLY" }, noConfirm, t0);
      await InviteService.revoke(org.owner, a.invite.id, t0);
      const list = await InviteService.list(org.owner, t0);
      expect(list.map((i) => [i.email, i.status])).toEqual([["b@example.test", "PENDING"], ["a@example.test", "REVOKED"]]);
      expect(list[0]!.codePrefix).toBe(b.code.slice(0, 10));
      const json = JSON.stringify(list);
      for (const secret of [a.code, b.code, hashInviteCode(a.code), hashInviteCode(b.code)]) expect(json).not.toContain(secret);
      const later = await InviteService.list(org.owner, new Date(t0.getTime() + 9 * 86_400_000));
      expect(later.map((i) => i.status).sort()).toEqual(["EXPIRED", "REVOKED"]);
    });
  });

  describe("redeeming an invite", () => {
    it("creates exactly one READ_ONLY membership for the matching account, consumes the invite, and audits who joined via which invite - never the code", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "Joiner@Example.test", role: "READ_ONLY" }, noConfirm);
      const joiner = await register("joiner@example.test");

      const joined = await InviteService.redeem(joiner.id, code, { clientKeys: ["ip:198.51.100.4"] });
      expect(joined.role).toBe("READ_ONLY");
      expect(joined.organization.id).toBe(org.organizationId);

      const members = await activeMembers(org.organizationId);
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.userId === joiner.id)?.role).toBe("READ_ONLY");

      const row = await inviteRow(org.organizationId, invite.id);
      expect(row.usedAt).toBeInstanceOf(Date);
      expect(row.usedByUserId).toBe(joiner.id);

      const audits = await auditRows(org.organizationId);
      const created = audits.find((a) => a.action === "membership.created" && a.actorUserId === joiner.id)!;
      expect(created.metadata).toMatchObject({ viaInviteId: invite.id });
      const redeemed = audits.find((a) => a.action === "organization_invite.redeemed")!;
      expect(redeemed).toMatchObject({ entityId: invite.id, actorUserId: joiner.id });
      expect(redeemed.metadata).toMatchObject({ codePrefix: invite.codePrefix, via: "chooser" });
      // The secret (and its hash) appear nowhere in the organization's audit log.
      const everything = JSON.stringify(audits);
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(code.slice(4));
      expect(everything).not.toContain(hashInviteCode(code));
    });

    it("accepts the code as a person might paste it (spaces, upper case)", async () => {
      const { code } = await InviteService.create(org.owner, { email: "paste@example.test", role: "READ_ONLY" }, noConfirm);
      const joiner = await register("paste@example.test");
      await expect(InviteService.redeem(joiner.id, `  ${code.toUpperCase()}  `)).resolves.toMatchObject({ role: "READ_ONLY" });
    });

    it("a different account (wrong email) gets the generic error, and the invite stays valid for the right person", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "right@example.test", role: "READ_ONLY" }, noConfirm);
      const wrong = await register("wrong@example.test");
      await expect(InviteService.redeem(wrong.id, code)).rejects.toBeInstanceOf(InviteInvalidError);
      expect((await inviteRow(org.organizationId, invite.id)).usedAt).toBeNull();
      expect(await activeMembers(org.organizationId)).toHaveLength(1);

      const right = await register("right@example.test");
      await expect(InviteService.redeem(right.id, code)).resolves.toBeTruthy();
    });

    it("every refusal is the SAME message: unknown, malformed, wrong email, expired, revoked, used, archived company", async () => {
      const t0 = new Date("2026-06-01T00:00:00Z");
      const live = await InviteService.create(org.owner, { email: "u@example.test", role: "READ_ONLY" }, noConfirm, t0);
      const toRevoke = await InviteService.create(org.owner, { email: "u@example.test", role: "READ_ONLY" }, noConfirm, t0);
      const toExpire = await InviteService.create(org.owner, { email: "u@example.test", role: "READ_ONLY" }, noConfirm, t0);
      await InviteService.revoke(org.owner, toRevoke.invite.id, t0);
      const user = await register("u@example.test");
      const other = await register("o@example.test");

      const messages = new Set<string>();
      const attempt = async (userId: string, code: string, now: Date) => {
        const err = await InviteService.redeem(userId, code, { now, throttle: new AuthThrottle(1000) }).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err, code.slice(0, 12)).toBeInstanceOf(InviteInvalidError);
        messages.add(err!.message);
      };
      await attempt(user.id, "mmj_" + "a".repeat(32), t0); // unknown
      await attempt(user.id, "garbage", t0); // malformed
      await attempt(other.id, live.code, t0); // wrong email
      await attempt(user.id, toRevoke.code, t0); // revoked
      await attempt(user.id, toExpire.code, new Date(t0.getTime() + 7 * 86_400_000)); // expired (exactly at expiry)
      // used: redeem the live one, then try again
      await InviteService.redeem(user.id, live.code, { now: t0, throttle: new AuthThrottle(1000) });
      await attempt(user.id, live.code, t0);
      // archived company
      const second = await InviteService.create(org.owner, { email: "o@example.test", role: "READ_ONLY" }, noConfirm, t0);
      await OrganizationLifecycleService.archive(org.owner, { confirmName: (await orgName(org.organizationId)), acknowledged: true, reason: "closing the books" });
      await attempt(other.id, second.code, t0);
      expect(messages.size).toBe(1);
    });

    it("a full company returns the specific seat message and the invite stays valid; freeing a seat lets the same code work", async () => {
      await addTestMember(org.owner, "READ_ONLY", "Filler"); // seat 2 of 2
      const { invite, code } = await InviteService.create(org.owner, { email: "late@example.test", role: "READ_ONLY" }, noConfirm);
      const late = await register("late@example.test");

      const err = await InviteService.redeem(late.id, code).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SeatLimitReachedError);
      expect((err as Error).message).toMatch(/seat limit \(2 of 2 seats used\)/);
      expect((await inviteRow(org.organizationId, invite.id)).usedAt).toBeNull();
      expect(await activeMembers(org.organizationId)).toHaveLength(2);
      // A seat-limit refusal is not a failed guess: it does not count toward the throttle.
      expect(inviteRedeemThrottle.retryAfterSeconds(`user:${late.id}`)).toBe(0);

      const members = await OrganizationService.listMembers(org.owner);
      const filler = members.find((m) => m.name === "Filler")!;
      await OrganizationService.removeMember(org.owner, filler.membershipId);
      await expect(InviteService.redeem(late.id, code)).resolves.toBeTruthy();
      expect(await activeMembers(org.organizationId)).toHaveLength(2);
    });

    it("two simultaneous redemptions of one code produce exactly one membership", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "race@example.test", role: "READ_ONLY" }, noConfirm);
      const racer = await register("race@example.test");
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => InviteService.redeem(racer.id, code, { throttle: new AuthThrottle(1000) })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failures).toHaveLength(4);
      for (const f of failures) expect(f.reason).toBeInstanceOf(InviteInvalidError);

      const mine = (await activeMembers(org.organizationId)).filter((m) => m.userId === racer.id);
      expect(mine).toHaveLength(1);
      const all = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, racer.id));
      expect(all).toHaveLength(1);
      expect((await inviteRow(org.organizationId, invite.id)).usedByUserId).toBe(racer.id);
      const redeemedAudits = (await auditRows(org.organizationId)).filter((a) => a.action === "organization_invite.redeemed");
      expect(redeemedAudits).toHaveLength(1);
    });

    it("two different invites racing for the last seat: exactly one wins, the other gets the seat message and stays valid", async () => {
      const one = await InviteService.create(org.owner, { email: "one@example.test", role: "READ_ONLY" }, noConfirm);
      const two = await InviteService.create(org.owner, { email: "two@example.test", role: "READ_ONLY" }, noConfirm);
      const u1 = await register("one@example.test");
      const u2 = await register("two@example.test");
      const t = new AuthThrottle(1000);
      const results = await Promise.allSettled([InviteService.redeem(u1.id, one.code, { throttle: t }), InviteService.redeem(u2.id, two.code, { throttle: t })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(loser.reason).toBeInstanceOf(SeatLimitReachedError);
      expect(await activeMembers(org.organizationId)).toHaveLength(2);
      const pending = (await InviteService.list(org.owner)).filter((i) => i.status === "PENDING");
      expect(pending).toHaveLength(1);
    });

    it("an archived company's invite is generic-invalid, stays on file, and works again after the company is restored", async () => {
      const { code } = await InviteService.create(org.owner, { email: "back@example.test", role: "READ_ONLY" }, noConfirm);
      const user = await register("back@example.test");
      await OrganizationLifecycleService.archive(org.owner, { confirmName: await orgName(org.organizationId), acknowledged: true, reason: "pausing for a while" });
      await expect(InviteService.redeem(user.id, code)).rejects.toBeInstanceOf(InviteInvalidError);
      await OrganizationLifecycleService.restore(org.owner.userId, org.organizationId);
      await expect(InviteService.redeem(user.id, code)).resolves.toBeTruthy();
    });

    it("re-activates a previously removed member rather than failing on the unique (organization, user) index", async () => {
      const prior = await addTestMember(org.owner, "BOOKKEEPER", "Boomerang");
      const [row] = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, prior.userId));
      await OrganizationService.removeMember(org.owner, row!.id);
      const { code } = await InviteService.create(org.owner, { email: await emailOf(prior.userId), role: "READ_ONLY" }, noConfirm);
      await InviteService.redeem(prior.userId, code);
      const rows = await db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, prior.userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ isActive: true, role: "READ_ONLY" });
    });

    it("someone who is already an active member gets a clear message and does not consume the invite", async () => {
      const member = await addTestMember(org.owner, "READ_ONLY", "Already");
      // The create path refuses an existing member's email, so point a fresh invite at them directly (superuser, test
      // setup only) to exercise the redeem-side guard.
      const { invite, code } = await InviteService.create(org.owner, { email: "temp@example.test", role: "READ_ONLY" }, noConfirm);
      await adminSql("update organization_invites set email = $1 where id = $2", [await emailOf(member.userId), invite.id]);
      await expect(InviteService.redeem(member.userId, code)).rejects.toBeInstanceOf(AlreadyMemberError);
      expect((await inviteRow(org.organizationId, invite.id)).usedAt).toBeNull();
    });
  });

  describe("throttling failed guesses (best effort, per instance)", () => {
    it("after repeated failures the person - and the shared address - are refused outright, even with the right code; others are unaffected", async () => {
      const { code } = await InviteService.create(org.owner, { email: "guesser@example.test", role: "READ_ONLY" }, noConfirm);
      const guesser = await register("guesser@example.test");
      const bystander = await register("bystander@example.test");
      const throttle = new AuthThrottle(3, 60_000);
      const now = new Date("2026-06-01T00:00:00Z");
      const opts = { throttle, now, clientKeys: ["ip:203.0.113.50"] };

      for (let i = 0; i < 3; i++) {
        await expect(InviteService.redeem(guesser.id, "mmj_" + "b".repeat(32), opts)).rejects.toBeInstanceOf(InviteInvalidError);
      }
      // Now locked: even the CORRECT code is refused without being checked.
      const locked = await InviteService.redeem(guesser.id, code, opts).then(() => null, (e: unknown) => e);
      expect(locked).toBeInstanceOf(InviteThrottledError);
      expect((locked as InviteThrottledError).retryAfterSeconds).toBeGreaterThan(0);
      expect(await activeMembers(org.organizationId)).toHaveLength(1);

      // The shared address is locked for a different account on it...
      await expect(InviteService.redeem(bystander.id, code, opts)).rejects.toBeInstanceOf(InviteThrottledError);
      // ...but not that account from elsewhere, and the lock expires with the window.
      await expect(InviteService.redeem(bystander.id, code, { throttle, now, clientKeys: ["ip:198.51.100.9"] })).rejects.toBeInstanceOf(InviteInvalidError);
      const later = new Date(now.getTime() + 61_000);
      await expect(InviteService.redeem(guesser.id, code, { ...opts, now: later })).resolves.toBeTruthy();
    });

    it("malformed input also counts as a failed attempt (it never reaches the database but still spends the allowance)", async () => {
      const user = await register("fuzz@example.test");
      const throttle = new AuthThrottle(2, 60_000);
      for (let i = 0; i < 2; i++) await expect(InviteService.redeem(user.id, "nonsense", { throttle })).rejects.toBeInstanceOf(InviteInvalidError);
      await expect(InviteService.redeem(user.id, "nonsense", { throttle })).rejects.toBeInstanceOf(InviteThrottledError);
    });
  });

  describe("revoking", () => {
    it("a revoked invite can no longer be redeemed; a used or already-revoked one cannot be revoked; an unknown id is not found", async () => {
      const a = await InviteService.create(org.owner, { email: "r1@example.test", role: "READ_ONLY" }, noConfirm);
      const u = await register("r1@example.test");
      await InviteService.revoke(org.owner, a.invite.id);
      await expect(InviteService.redeem(u.id, a.code)).rejects.toBeInstanceOf(InviteInvalidError);
      await expect(InviteService.revoke(org.owner, a.invite.id)).rejects.toBeInstanceOf(InviteNotPendingError);

      const b = await InviteService.create(org.owner, { email: "r2@example.test", role: "READ_ONLY" }, noConfirm);
      const u2 = await register("r2@example.test");
      await InviteService.redeem(u2.id, b.code);
      await expect(InviteService.revoke(org.owner, b.invite.id)).rejects.toBeInstanceOf(InviteNotPendingError);
      await expect(InviteService.revoke(org.owner, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(InviteNotFoundError);

      const revokedAudit = (await auditRows(org.organizationId)).find((r) => r.action === "organization_invite.revoked")!;
      expect(revokedAudit.entityId).toBe(a.invite.id);
      expect(JSON.stringify(revokedAudit)).not.toContain(a.code);
    });

    it("one organization's manager cannot revoke (or see) another organization's invite", async () => {
      const other = await createTestOrg("invites-other");
      const theirs = await InviteService.create(other.owner, { email: "t@example.test", role: "READ_ONLY" }, noConfirm);
      await expect(InviteService.revoke(org.owner, theirs.invite.id)).rejects.toBeInstanceOf(InviteNotFoundError);
      expect(await InviteService.list(org.owner)).toEqual([]);
      expect((await inviteRow(other.organizationId, theirs.invite.id)).revokedAt).toBeNull();
    });
  });

  describe("secrecy", () => {
    it("the code appears in no audit row, and only its hash is stored (in the non-tenant index)", async () => {
      const { invite, code } = await InviteService.create(org.owner, { email: "s@example.test", role: "READ_ONLY" }, noConfirm);
      const user = await register("s@example.test");
      await InviteService.redeem(user.id, code);
      await InviteService.create(org.owner, { email: "t@example.test", role: "READ_ONLY" }, noConfirm).then((r) => InviteService.revoke(org.owner, r.invite.id));

      const audits = JSON.stringify(await auditRows(org.organizationId));
      expect(audits).not.toContain(code);
      expect(audits).not.toContain(hashInviteCode(code));
      const [indexed] = await db.select().from(organizationInviteIndex).where(eq(organizationInviteIndex.id, invite.id));
      expect(indexed!.codeHash).toBe(hashInviteCode(code));
      const [stored] = await db.select().from(organizations).where(eq(organizations.id, org.organizationId));
      expect(JSON.stringify(stored)).not.toContain(code);
    });
  });
});

async function orgName(organizationId: string): Promise<string> {
  const [row] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
  return row!.name;
}

async function emailOf(userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row!.email;
}

/** Runs one statement as the superuser (tests only) to set up a state the application itself refuses to create. */
async function adminSql(text: string, values: unknown[]) {
  const pool = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
  try {
    await pool.query(text, values);
  } finally {
    await pool.end();
  }
}
