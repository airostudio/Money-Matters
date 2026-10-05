import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, createTestUser, resetDatabase } from "../../helpers/db";
import { acceptProposal, createPracticeWorld, joinClient, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { withUserScope } from "@/db/user-scope";
import { auditLogs, organizations, practiceAuditLogs, practiceClientLinks } from "@/db/schema";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { PracticeConsentService } from "@/domain/practice/consent-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { requireClientActor } from "@/domain/practice/client-access";
import {
  InvalidAssigneeError,
  LinkAlreadyExistsError,
  LinkDeclinedError,
  LinkNotActiveError,
  NotAClientMemberError,
  PracticePermissionError,
  ProposalNotPossibleError,
} from "@/domain/practice/errors";
import { MAX_PENDING_PROPOSALS_PER_ORG } from "@/domain/practice/types";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { OrganizationService, SeatLimitReachedError } from "@/domain/organizations/organization-service";

describe("Client links — the two-sided consent handshake, revocation and seat limits", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;
  const ids = () => w.clients;

  const linkStatuses = async () => {
    const rows = await ClientLinkService.list(w.partnerActor, w.practiceId);
    return Object.fromEntries(rows.map((r) => [r.clientName, r.status]));
  };

  const clientAudit = (key: "A" | "B" | "C" | "D") =>
    withTenant(ids()[key].organizationId, (tx) =>
      tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, ids()[key].organizationId), eq(auditLogs.entityType, "AccountantPractice"))),
    );

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
  });

  describe("proposal, acceptance, decline", () => {
    it("the practice can only PROPOSE: the link is PENDING and nothing is readable until the client accepts", async () => {
      expect(await linkStatuses()).toMatchObject({ [ids().B.name]: "PENDING" });
      await expect(
        requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().B.organizationId, name: ids().B.name }),
      ).rejects.toBeInstanceOf(LinkNotActiveError);
    });

    it("only the client's OWNER or ADMINISTRATOR can accept, decline or revoke — S1 is an ACCOUNTANT there and may not", async () => {
      const [consent] = await PracticeConsentService.list(ids().B.owner);
      const s1InB = w.s1In("B", "ACCOUNTANT");
      await expect(PracticeConsentService.accept(s1InB, consent!.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PracticeConsentService.decline(s1InB, consent!.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PracticeConsentService.list(s1InB)).rejects.toBeInstanceOf(PermissionDeniedError);
      // An administrator can.
      const admin = await createTestUser("Admin");
      await joinClient(ids().B, admin, "ADMINISTRATOR");
      const accepted = await PracticeConsentService.accept({ userId: admin.id, organizationId: ids().B.organizationId, role: "ADMINISTRATOR" }, consent!.id);
      expect(accepted.status).toBe("ACTIVE");
    });

    it("accepting grants no data access by itself: a staff member who is not a member of the client still cannot read it", async () => {
      // D is ACTIVE but S1 is not a member of D.
      await expect(
        requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().D.organizationId, name: ids().D.name }),
      ).rejects.toBeInstanceOf(NotAClientMemberError);
      // A: member + ACTIVE link -> S1's real role.
      const actor = await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().A.organizationId, name: ids().A.name });
      expect(actor).toMatchObject({ userId: w.s1.id, organizationId: ids().A.organizationId, role: "ACCOUNTANT" });
    });

    it("the role used is the staff member's actual membership role: a role change in the client is picked up on the next read", async () => {
      const membershipId = (await OrganizationService.listMembers(ids().A.owner)).find((m) => m.userId === w.s1.id)!.membershipId;
      await OrganizationService.updateMemberRole(ids().A.owner, membershipId, "READ_ONLY");
      const actor = await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().A.organizationId, name: ids().A.name });
      expect(actor.role).toBe("READ_ONLY");
    });

    it("a declined link cannot be re-proposed by the practice; the client may re-approve it itself", async () => {
      const [consent] = await PracticeConsentService.list(ids().B.owner);
      await PracticeConsentService.decline(ids().B.owner, consent!.id);
      await expect(ClientLinkService.propose(w.partnerActor, w.practiceId, ids().B.slug)).rejects.toBeInstanceOf(LinkDeclinedError);
      await PracticeConsentService.accept(ids().B.owner, consent!.id);
      expect(await PracticeConsentService.statusFor(ids().B.organizationId, w.practiceId)).toBe("ACTIVE");
    });

    it("proposing an already ACTIVE client is refused; re-proposing a PENDING one is idempotent", async () => {
      await expect(ClientLinkService.propose(w.partnerActor, w.practiceId, ids().A.slug)).rejects.toBeInstanceOf(LinkAlreadyExistsError);
      await ClientLinkService.propose(w.partnerActor, w.practiceId, ids().B.slug);
      expect((await PracticeConsentService.list(ids().B.owner)).length).toBe(1);
    });

    it("an unknown slug and a full pending queue give the same generic error (nothing is revealed)", async () => {
      await expect(ClientLinkService.propose(w.partnerActor, w.practiceId, "no-such-org-anywhere")).rejects.toBeInstanceOf(ProposalNotPossibleError);
      // Fill client B's pending queue with other practices.
      for (let i = 0; i < MAX_PENDING_PROPOSALS_PER_ORG - 1; i += 1) {
        const founder = await createTestUser(`Spammer${i}`);
        const p = await PracticeService.create({ userId: founder.id }, { name: `Spam ${i}` });
        await ClientLinkService.propose({ userId: founder.id }, p.id, ids().B.slug);
      }
      const last = await createTestUser("LastSpammer");
      const p = await PracticeService.create({ userId: last.id }, { name: "One too many" });
      await expect(ClientLinkService.propose({ userId: last.id }, p.id, ids().B.slug)).rejects.toBeInstanceOf(ProposalNotPossibleError);
    });

    it("only MANAGER or above can propose", async () => {
      await expect(ClientLinkService.propose(w.s2Actor, w.practiceId, ids().B.slug)).rejects.toBeInstanceOf(PracticePermissionError);
    });
  });

  describe("revocation", () => {
    it("is immediate: the very next read is refused, with no practice-side action needed", async () => {
      await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().A.organizationId, name: ids().A.name });
      await revokeConsent(ids().A, w.practiceId);
      await expect(
        requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().A.organizationId, name: ids().A.name }),
      ).rejects.toBeInstanceOf(LinkNotActiveError);
    });

    it("verification brings the practice's working copy in line, audits the change and blanks any retained snapshot figures", async () => {
      expect(await linkStatuses()).toMatchObject({ [ids().C.name]: "REVOKED", [ids().A.name]: "ACTIVE", [ids().D.name]: "ACTIVE" });
      await revokeConsent(ids().A, w.practiceId);
      // Before the practice looks, its copy still says ACTIVE...
      expect((await linkStatuses())[ids().A.name]).toBe("ACTIVE");
      const changes = await ClientLinkService.verify(w.s1Actor, w.practiceId, [ids().A.organizationId]);
      expect(changes).toEqual([{ clientOrganizationId: ids().A.organizationId, from: "ACTIVE", to: "REVOKED" }]);
      expect((await linkStatuses())[ids().A.name]).toBe("REVOKED");
      const audit = await withUserScope(w.partner.id, (tx) =>
        tx.select({ action: practiceAuditLogs.action }).from(practiceAuditLogs).where(eq(practiceAuditLogs.action, "client_link.status_observed")),
      );
      expect(audit.length).toBeGreaterThanOrEqual(2); // C (setup) and A
    });

    it("a revoked link can be proposed again, and then needs a fresh acceptance", async () => {
      await ClientLinkService.propose(w.partnerActor, w.practiceId, ids().C.slug);
      expect(await PracticeConsentService.statusFor(ids().C.organizationId, w.practiceId)).toBe("PENDING");
      expect((await linkStatuses())[ids().C.name]).toBe("PENDING");
      await acceptProposal(ids().C, w.practiceId);
      await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().C.organizationId, name: ids().C.name });
    });

    it("the practice can end a link itself; partner-only for an ACTIVE one", async () => {
      await expect(ClientLinkService.withdraw(w.s2Actor, w.practiceId, ids().A.organizationId)).rejects.toBeInstanceOf(PracticePermissionError);
      await ClientLinkService.withdraw(w.partnerActor, w.practiceId, ids().A.organizationId);
      expect(await PracticeConsentService.statusFor(ids().A.organizationId, w.practiceId)).toBe("WITHDRAWN");
      expect((await linkStatuses())[ids().A.name]).toBe("WITHDRAWN");
      await expect(
        requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().A.organizationId, name: ids().A.name }),
      ).rejects.toBeInstanceOf(LinkNotActiveError);
    });
  });

  describe("audit trails on both sides", () => {
    it("the client's own audit log shows proposed / accepted / revoked with the opaque practice id and actor — never the practice's name or other clients", async () => {
      const entries = await clientAudit("C");
      const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));
      expect(Object.keys(byAction).sort()).toEqual(["practice_link.accepted", "practice_link.proposed", "practice_link.revoked"]);
      expect(byAction["practice_link.proposed"]!.actorUserId).toBe(w.partner.id);
      expect(byAction["practice_link.accepted"]!.actorUserId).toBe(ids().C.owner.userId);
      const blob = JSON.stringify(entries);
      expect(blob).toContain(w.practiceId);
      expect(blob).not.toContain("Smith & Co");
      expect(blob).not.toContain(ids().A.name);
      expect(blob).not.toContain(ids().A.organizationId);
    });

    it("assigning staff leaves an informational note only when the link is ACTIVE; the assignee must be an active practice member", async () => {
      await ClientLinkService.assign(w.partnerActor, w.practiceId, ids().A.organizationId, w.s1.id);
      await ClientLinkService.assign(w.partnerActor, w.practiceId, ids().B.organizationId, w.s1.id); // B is only PENDING
      const noteA = (await clientAudit("A")).filter((e) => e.action === "practice_link.staff_assigned");
      expect(noteA.length).toBe(1);
      expect(JSON.stringify(noteA[0]!.metadata)).not.toContain(w.s1.id); // the assignee is not disclosed
      expect((await clientAudit("B")).filter((e) => e.action === "practice_link.staff_assigned")).toEqual([]);

      const rows = await ClientLinkService.list(w.partnerActor, w.practiceId);
      expect(rows.find((r) => r.clientOrganizationId === ids().A.organizationId)!.assignedUserId).toBe(w.s1.id);

      await expect(ClientLinkService.assign(w.partnerActor, w.practiceId, ids().A.organizationId, w.outsider.id)).rejects.toBeInstanceOf(InvalidAssigneeError);
      await expect(ClientLinkService.assign(w.s1Actor, w.practiceId, ids().A.organizationId, w.s1.id)).rejects.toBeInstanceOf(PracticePermissionError);
    });

    it("assignment grants no client access: an assignee who is not a client member still cannot read the client", async () => {
      await ClientLinkService.assign(w.partnerActor, w.practiceId, ids().D.organizationId, w.s1.id);
      await expect(
        requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().D.organizationId, name: ids().D.name }),
      ).rejects.toBeInstanceOf(NotAClientMemberError);
    });

    it("the practice's link rows record who proposed them", async () => {
      const rows = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceClientLinks).where(eq(practiceClientLinks.practiceId, w.practiceId)));
      expect(rows.every((r) => r.proposedByUserId === w.partner.id)).toBe(true);
    });
  });

  describe("staff who join a client organization use its seats — and the limit is never bypassed", () => {
    it("names the seat position specifically when the client is full, and the platform raising the limit lets the add succeed", async () => {
      // Client D: seat limit 2 = its owner + one more member.
      await db.update(organizations).set({ seatLimit: 2 }).where(eq(organizations.id, ids().D.organizationId));
      const filler = await createTestUser("Filler");
      await joinClient(ids().D, filler, "READ_ONLY");

      const error = await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().D.organizationId, name: ids().D.name }).catch((e) => e);
      expect(error).toBeInstanceOf(NotAClientMemberError);
      expect(error.message).toContain("seat limit (2 of 2 seats used)");
      expect(error.message).toContain("platform administrator");
      expect(error.message).toContain("the limit is not bypassed");

      // The real seat rule is untouched: the owner still cannot add S1 while full.
      await expect(OrganizationService.addMemberByEmail(ids().D.owner, w.s1.email, "ACCOUNTANT")).rejects.toBeInstanceOf(SeatLimitReachedError);

      // The platform administrator raises the limit for that organization; now the owner can add S1 and the practice can read.
      await db.update(organizations).set({ seatLimit: 3 }).where(eq(organizations.id, ids().D.organizationId));
      await OrganizationService.addMemberByEmail(ids().D.owner, w.s1.email, "ACCOUNTANT");
      const actor = await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().D.organizationId, name: ids().D.name });
      expect(actor.role).toBe("ACCOUNTANT");
    });

    it("when a seat is free the message says adding the person uses one", async () => {
      const error = await requireClientActor(w.s1.id, w.practiceId, { organizationId: ids().D.organizationId, name: ids().D.name }).catch((e) => e);
      expect(error.message).toMatch(/uses one of its seats \(1 of 50 used\)/);
    });
  });
});
