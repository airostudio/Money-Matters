import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, createTestUser, pgMessage, resetDatabase } from "../../helpers/db";
import { createPracticeWorld, joinClient, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { withTenant } from "@/db/tenant";
import { auditLogs, clientRequestMessages, clientRequests, practiceClientConsents, uploadedReceipts } from "@/db/schema";
import { ClientRequestClosedError, ClientRequestNotFoundError, ClientRequestService } from "@/domain/client-requests/client-request-service";
import { PracticeRequestService } from "@/domain/practice/practice-request-service";
import { LinkNotActiveError, NotAClientMemberError } from "@/domain/practice/errors";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { DocumentFileTooLargeError, UnsupportedDocumentFileTypeError } from "@/domain/documents/document-validation";

const PDF = { fileName: "bank-statement.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 fake statement") };

describe("Client queries and document requests — visible to the client, raised through the client's own RBAC", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;
  let aBookkeeper: Actor;
  const A = () => w.clients.A.organizationId;

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
    const bk = await createTestUser("ClientBookkeeper");
    await joinClient(w.clients.A, bk, "BOOKKEEPER");
    aBookkeeper = { userId: bk.id, organizationId: A(), role: "BOOKKEEPER" };
  });

  const raise = () =>
    PracticeRequestService.create(w.s1Actor, w.practiceId, A(), {
      type: "DOCUMENT_REQUEST",
      subject: "September bank statement",
      body: "Please upload the September statement for the Everyday Account.",
      dueDate: "2026-10-15",
    });

  it("the practice raises a request (as S1, with S1's real ACCOUNTANT role in the client); the client's own members see it in their inbox", async () => {
    const created = await raise();
    expect(created).toMatchObject({ status: "OPEN", type: "DOCUMENT_REQUEST", practiceId: w.practiceId, practiceName: "Smith & Co Accountants", dueDate: "2026-10-15", requestedByName: "StaffOne" });

    const inbox = await ClientRequestService.list(aBookkeeper);
    expect(inbox.map((r) => r.subject)).toEqual(["September bank statement"]);
    expect(await ClientRequestService.countOpen(w.clients.A.owner)).toBe(1);
    // The practice sees its own request under that client too.
    expect((await PracticeRequestService.list(w.s1Actor, w.practiceId, A())).length).toBe(1);
  });

  it("the client answers with a document: status moves to ANSWERED, the attachment is stored in the client's receipt store and the practice can read the reply", async () => {
    const req = await raise();
    const reply = await ClientRequestService.reply(aBookkeeper, req.id, { body: "Statement attached.", side: "CLIENT", attachment: PDF });
    expect(reply.status).toBe("ANSWERED");

    const detail = await PracticeRequestService.get(w.s1Actor, w.practiceId, A(), req.id);
    expect(detail.status).toBe("ANSWERED");
    expect(detail.messages.map((m) => [m.authorSide, m.authorName])).toEqual([["CLIENT", "ClientBookkeeper"]]);
    expect(detail.messages[0]!.attachment).toMatchObject({ fileName: "bank-statement.pdf", mimeType: "application/pdf", fileSize: PDF.data.byteLength });

    const file = await PracticeRequestService.getAttachment(w.s1Actor, w.practiceId, A(), req.id, detail.messages[0]!.id);
    expect(file.data.equals(PDF.data)).toBe(true);
    const stored = await withTenant(A(), (tx) => tx.select().from(uploadedReceipts));
    expect(stored.length).toBe(1);
  });

  it("a practice reply re-opens an answered request; closing stops further replies until reopened", async () => {
    const req = await raise();
    await ClientRequestService.reply(aBookkeeper, req.id, { body: "Done", side: "CLIENT" });
    const back = await PracticeRequestService.reply(w.s1Actor, w.practiceId, A(), req.id, { body: "Thanks — one more page please." });
    expect(back.status).toBe("OPEN");
    await PracticeRequestService.close(w.s1Actor, w.practiceId, A(), req.id);
    await expect(ClientRequestService.reply(aBookkeeper, req.id, { body: "late", side: "CLIENT" })).rejects.toBeInstanceOf(ClientRequestClosedError);
    await PracticeRequestService.reopen(w.s1Actor, w.practiceId, A(), req.id);
    expect((await PracticeRequestService.get(w.s1Actor, w.practiceId, A(), req.id)).status).toBe("OPEN");
  });

  describe("access follows the client's own roles and the consent", () => {
    it("a staff member who is not a member of the client cannot raise or read requests there; nor can the practice's partner", async () => {
      await expect(PracticeRequestService.create(w.s2Actor, w.practiceId, A(), { type: "QUERY", subject: "x", body: "y" })).rejects.toBeInstanceOf(NotAClientMemberError);
      await expect(PracticeRequestService.list(w.partnerActor, w.practiceId, A())).rejects.toBeInstanceOf(NotAClientMemberError);
    });

    it("the client's roles decide who can read, answer and raise", async () => {
      const req = await raise();
      const mk = async (role: Actor["role"]): Promise<Actor> => {
        const u = await createTestUser(`Client${role}`);
        await joinClient(w.clients.A, u, role);
        return { userId: u.id, organizationId: A(), role };
      };
      const readOnly = await mk("READ_ONLY");
      const manager = await mk("MANAGER");
      await expect(ClientRequestService.list(readOnly)).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await ClientRequestService.list(manager)).length).toBe(1); // MANAGER may read...
      await expect(ClientRequestService.reply(manager, req.id, { body: "hi", side: "CLIENT" })).rejects.toBeInstanceOf(PermissionDeniedError); // ...but not respond
      await expect(ClientRequestService.create(aBookkeeper, { practiceId: w.practiceId, type: "QUERY", subject: "s", body: "b" })).resolves.toBeTruthy(); // BOOKKEEPER has manage
      await expect(ClientRequestService.create(manager, { practiceId: w.practiceId, type: "QUERY", subject: "s", body: "b" })).rejects.toBeInstanceOf(PermissionDeniedError);
      // A client member cannot post a message AS the practice without manage + consent.
      await expect(ClientRequestService.reply(manager, req.id, { body: "x", side: "PRACTICE" })).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("a PENDING practice cannot raise anything; a REVOKED one cannot raise, read or reply — while the client keeps the history", async () => {
      await expect(
        PracticeRequestService.create(w.s1Actor, w.practiceId, w.clients.B.organizationId, { type: "QUERY", subject: "x", body: "y" }),
      ).rejects.toBeInstanceOf(LinkNotActiveError);

      const req = await raise();
      await revokeConsent(w.clients.A, w.practiceId);
      await expect(PracticeRequestService.list(w.s1Actor, w.practiceId, A())).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(PracticeRequestService.get(w.s1Actor, w.practiceId, A(), req.id)).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(PracticeRequestService.reply(w.s1Actor, w.practiceId, A(), req.id, { body: "x" })).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(PracticeRequestService.create(w.s1Actor, w.practiceId, A(), { type: "QUERY", subject: "x", body: "y" })).rejects.toBeInstanceOf(LinkNotActiveError);
      // Even if the staff member used the client's service directly with their real role, the consent is checked in the same transaction.
      await expect(ClientRequestService.reply(w.s1In("A"), req.id, { body: "sneaky", side: "PRACTICE" })).rejects.toThrow(/not currently linked/);
      expect((await ClientRequestService.list(aBookkeeper)).length).toBe(1);
    });

    it("a practice sees only ITS requests: another practice's request in the same client is invisible to it", async () => {
      const req = await raise();
      const other = await createTestUser("OtherAccountant");
      const { PracticeService } = await import("@/domain/practice/practice-service");
      const { ClientLinkService } = await import("@/domain/practice/client-link-service");
      const { acceptProposal } = await import("../../helpers/practice");
      const p2 = await PracticeService.create({ userId: other.id }, { name: "Rival Practice" });
      await joinClient(w.clients.A, other, "ACCOUNTANT");
      await ClientLinkService.propose({ userId: other.id }, p2.id, w.clients.A.slug);
      await acceptProposal(w.clients.A, p2.id);
      const theirs = await PracticeRequestService.create({ userId: other.id }, p2.id, A(), { type: "QUERY", subject: "Rival question", body: "?" });
      expect((await PracticeRequestService.list({ userId: other.id }, p2.id, A())).map((r) => r.subject)).toEqual(["Rival question"]);
      await expect(PracticeRequestService.get({ userId: other.id }, p2.id, A(), req.id)).rejects.toBeInstanceOf(ClientRequestNotFoundError);
      await expect(PracticeRequestService.get(w.s1Actor, w.practiceId, A(), theirs.id)).rejects.toBeInstanceOf(ClientRequestNotFoundError);
      // The client sees both.
      expect((await ClientRequestService.list(w.clients.A.owner)).length).toBe(2);
    });
  });

  describe("tenant isolation of the new tables (RLS, as the real restricted role)", () => {
    it("another organization sees none of A's requests, messages or consents — even by an unfiltered query", async () => {
      const req = await raise();
      await ClientRequestService.reply(aBookkeeper, req.id, { body: "reply", side: "CLIENT" });
      for (const key of ["B", "C", "D"] as const) {
        const seen = await withTenant(w.clients[key].organizationId, async (tx) => ({
          requests: await tx.select().from(clientRequests),
          messages: await tx.select().from(clientRequestMessages),
          consents: await tx.select().from(practiceClientConsents),
        }));
        expect(seen.requests, key).toEqual([]);
        expect(seen.messages, key).toEqual([]);
        expect(seen.consents.every((c) => c.organizationId === w.clients[key].organizationId), key).toBe(true);
      }
      // ...and cannot write a row into A's tenant either.
      expect(
        await pgMessage(
          withTenant(w.clients.B.organizationId, (tx) =>
            tx.insert(clientRequests).values({ organizationId: A(), practiceId: w.practiceId, practiceName: "x", type: "QUERY", subject: "x", body: "x", requestedByUserId: w.s1.id }),
          ),
        ),
      ).toMatch(/row-level security/i);
    });

    it("the request thread is append-only for the application role", async () => {
      const req = await raise();
      await ClientRequestService.reply(aBookkeeper, req.id, { body: "reply", side: "CLIENT" });
      expect(await pgMessage(withTenant(A(), (tx) => tx.update(clientRequestMessages).set({ body: "edited" }).where(eq(clientRequestMessages.requestId, req.id))))).toMatch(/permission denied/i);
      expect(await pgMessage(withTenant(A(), (tx) => tx.delete(clientRequestMessages).where(eq(clientRequestMessages.requestId, req.id))))).toMatch(/permission denied/i);
    });
  });

  describe("validation and audit", () => {
    it("attachments use the receipt store's validation: type, size and emptiness", async () => {
      const req = await raise();
      await expect(
        ClientRequestService.reply(aBookkeeper, req.id, { body: "x", side: "CLIENT", attachment: { fileName: "run.exe", mimeType: "application/x-msdownload", data: Buffer.from("MZ") } }),
      ).rejects.toBeInstanceOf(UnsupportedDocumentFileTypeError);
      await expect(
        ClientRequestService.reply(aBookkeeper, req.id, { body: "x", side: "CLIENT", attachment: { fileName: "big.pdf", mimeType: "application/pdf", data: Buffer.alloc(10 * 1024 * 1024 + 1) } }),
      ).rejects.toBeInstanceOf(DocumentFileTooLargeError);
      await expect(
        ClientRequestService.reply(aBookkeeper, req.id, { body: "x", side: "CLIENT", attachment: { fileName: "empty.pdf", mimeType: "application/pdf", data: Buffer.alloc(0) } }),
      ).rejects.toThrow(/empty/i);
      expect((await withTenant(A(), (tx) => tx.select().from(uploadedReceipts))).length).toBe(0);
    });

    it("a request needs a subject and message; due dates are checked", async () => {
      await expect(PracticeRequestService.create(w.s1Actor, w.practiceId, A(), { type: "QUERY", subject: " ", body: "x" })).rejects.toThrow(/subject and a message/);
      await expect(PracticeRequestService.create(w.s1Actor, w.practiceId, A(), { type: "QUERY", subject: "s", body: "b", dueDate: "tomorrow" })).rejects.toThrow(/YYYY-MM-DD/);
    });

    it("every step is in the client's own audit log (with the real actor) and the practice's audit log (ids only, never the message text)", async () => {
      const req = await raise();
      await ClientRequestService.reply(aBookkeeper, req.id, { body: "Statement attached.", side: "CLIENT" });
      await PracticeRequestService.close(w.s1Actor, w.practiceId, A(), req.id);
      const clientAudit = await withTenant(A(), (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "ClientRequest"), eq(auditLogs.entityId, req.id))));
      expect(clientAudit.map((a) => [a.action, a.actorUserId]).sort()).toEqual(
        [["client_request.created", w.s1.id], ["client_request.answered", aBookkeeper.userId], ["client_request.closed", w.s1.id]].sort(),
      );
      const { withUserScope } = await import("@/db/user-scope");
      const { practiceAuditLogs } = await import("@/db/schema");
      const practiceAudit = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceAuditLogs).where(eq(practiceAuditLogs.entityId, req.id)));
      expect(practiceAudit.map((a) => a.action).sort()).toEqual(["client_request.closed", "client_request.created"]);
      expect(JSON.stringify(practiceAudit)).not.toContain("September bank statement");
    });
  });
});
