import { and, asc, desc, eq, sql } from "drizzle-orm";
import { clientRequestMessages, clientRequests, practiceClientConsents, users } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { assertValidDocumentUpload } from "@/domain/documents/document-validation";
import { PostgresDocumentStorageProvider } from "@/domain/documents/storage-provider";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";

export type RequestType = "QUERY" | "DOCUMENT_REQUEST";
export type RequestStatus = "OPEN" | "ANSWERED" | "CLOSED";
export type MessageSide = "PRACTICE" | "CLIENT";

export class ClientRequestNotFoundError extends Error {
  constructor() {
    super("That request does not exist in this organization.");
    this.name = "ClientRequestNotFoundError";
  }
}

export class ClientRequestClosedError extends Error {
  constructor() {
    super("This request is closed. Ask your accountant to reopen it if you need to add something.");
    this.name = "ClientRequestClosedError";
  }
}

export class PracticeNotLinkedError extends Error {
  constructor() {
    super("That accountant practice is not currently linked to this organization.");
    this.name = "PracticeNotLinkedError";
  }
}

export class ClientRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRequestValidationError";
  }
}

export interface RequestView {
  id: string;
  practiceId: string;
  practiceName: string;
  type: RequestType;
  subject: string;
  body: string;
  status: RequestStatus;
  requestedByName: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  messageCount: number;
}

export interface MessageView {
  id: string;
  authorName: string;
  authorSide: MessageSide;
  body: string;
  attachment: { messageId: string; fileName: string; mimeType: string; fileSize: number } | null;
  createdAt: string;
}

export interface RequestDetail extends RequestView {
  messages: MessageView[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function view(r: typeof clientRequests.$inferSelect, requestedByName: string, messageCount: number): RequestView {
  return {
    id: r.id,
    practiceId: r.practiceId,
    practiceName: r.practiceName,
    type: r.type,
    subject: r.subject,
    body: r.body,
    status: r.status,
    requestedByName,
    dueDate: r.dueDate,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    messageCount,
  };
}

async function loadRequest(tx: TenantDb, organizationId: string, id: string, practiceId?: string) {
  const [row] = await tx
    .select()
    .from(clientRequests)
    .where(and(eq(clientRequests.id, id), eq(clientRequests.organizationId, organizationId), practiceId ? eq(clientRequests.practiceId, practiceId) : undefined))
    .for("update");
  if (!row) throw new ClientRequestNotFoundError();
  return row;
}

async function activeConsent(tx: TenantDb, organizationId: string, practiceId: string) {
  const [row] = await tx
    .select()
    .from(practiceClientConsents)
    .where(and(eq(practiceClientConsents.organizationId, organizationId), eq(practiceClientConsents.practiceId, practiceId)));
  if (!row || row.status !== "ACTIVE") throw new PracticeNotLinkedError();
  return row;
}

/**
 * Queries and document requests from a client's accountant, in the CLIENT's own
 * tenant (RLS on `app.current_org_id`, like any other tenant data) — so the client
 * sees them in its own "Requests from your accountant" inbox. They are the one
 * practice-to-client channel that is deliberately client-visible; a practice's
 * internal notes, tasks and workpapers are never stored here.
 *
 * Permissions (a real role in THIS organization, never a practice role):
 *  - `client_request:manage` raises, closes and reopens a request, and posts a
 *    PRACTICE-side reply — held by OWNER, ADMINISTRATOR, ACCOUNTANT, BOOKKEEPER;
 *  - `client_request:respond` replies as the CLIENT (text and one attachment) and
 *    `client_request:read` opens the inbox — ACCOUNTANT and BOOKKEEPER, plus MANAGER for
 *    read, and OWNER / ADMINISTRATOR for everything.
 * Raising or answering on a practice's behalf also needs that practice's consent to be
 * ACTIVE (checked in the same transaction), so a revoked practice can neither read nor post.
 * Attachments use the receipt document store and its validation. There is no email or
 * notification infrastructure: a request appears in the app, nowhere else.
 */
export const ClientRequestService = {
  async create(
    actor: Actor,
    input: { practiceId: string; type: RequestType; subject: string; body: string; dueDate?: string | null },
  ): Promise<RequestView> {
    assertPermission(actor, "client_request:manage");
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (!subject || !body) throw new ClientRequestValidationError("A request needs a subject and a message.");
    if (subject.length > 200) throw new ClientRequestValidationError("The subject must be 200 characters or fewer.");
    if (body.length > 5000) throw new ClientRequestValidationError("The message must be 5000 characters or fewer.");
    if (input.type !== "QUERY" && input.type !== "DOCUMENT_REQUEST") throw new ClientRequestValidationError("Unknown request type.");
    if (input.dueDate && (!YMD.test(input.dueDate) || Number.isNaN(Date.parse(`${input.dueDate}T00:00:00Z`)))) {
      throw new ClientRequestValidationError("The due date must be YYYY-MM-DD.");
    }
    return withTenant(actor.organizationId, async (tx) => {
      const consent = await activeConsent(tx, actor.organizationId, input.practiceId);
      const [row] = await tx
        .insert(clientRequests)
        .values({
          organizationId: actor.organizationId,
          practiceId: input.practiceId,
          practiceName: consent.practiceName,
          type: input.type,
          subject,
          body,
          dueDate: input.dueDate || null,
          requestedByUserId: actor.userId,
        })
        .returning();
      await AuditService.record(tx, actor, {
        action: "client_request.created",
        entityType: "ClientRequest",
        entityId: row!.id,
        after: { type: input.type, subject },
        metadata: { practiceId: input.practiceId },
      });
      const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
      return view(row!, me?.name ?? "", 0);
    });
  },

  /** The inbox, newest first. `practiceId` narrows to one practice (the practice's own view of a client). */
  async list(actor: Actor, opts: { practiceId?: string; status?: RequestStatus } = {}): Promise<RequestView[]> {
    assertPermission(actor, "client_request:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({
          r: clientRequests,
          requestedByName: users.name,
          messageCount: sql<number>`(select count(*)::int from client_request_messages m where m.request_id = ${clientRequests.id})`,
        })
        .from(clientRequests)
        .innerJoin(users, eq(users.id, clientRequests.requestedByUserId))
        .where(
          and(
            eq(clientRequests.organizationId, actor.organizationId),
            opts.practiceId ? eq(clientRequests.practiceId, opts.practiceId) : undefined,
            opts.status ? eq(clientRequests.status, opts.status) : undefined,
          ),
        )
        .orderBy(desc(clientRequests.createdAt))
        .limit(200);
      return rows.map((x) => view(x.r, x.requestedByName, Number(x.messageCount)));
    });
  },

  /** How many requests are waiting for the CLIENT (status OPEN) — the inbox badge. */
  async countOpen(actor: Actor): Promise<number> {
    assertPermission(actor, "client_request:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(clientRequests)
        .where(and(eq(clientRequests.organizationId, actor.organizationId), eq(clientRequests.status, "OPEN")));
      return Number(row?.n ?? 0);
    });
  },

  async get(actor: Actor, requestId: string, opts: { practiceId?: string } = {}): Promise<RequestDetail> {
    assertPermission(actor, "client_request:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [found] = await tx
        .select({ r: clientRequests, requestedByName: users.name })
        .from(clientRequests)
        .innerJoin(users, eq(users.id, clientRequests.requestedByUserId))
        .where(
          and(
            eq(clientRequests.id, requestId),
            eq(clientRequests.organizationId, actor.organizationId),
            opts.practiceId ? eq(clientRequests.practiceId, opts.practiceId) : undefined,
          ),
        );
      if (!found) throw new ClientRequestNotFoundError();
      const msgs = await tx
        .select({ m: clientRequestMessages, authorName: users.name })
        .from(clientRequestMessages)
        .innerJoin(users, eq(users.id, clientRequestMessages.authorUserId))
        .where(and(eq(clientRequestMessages.requestId, requestId), eq(clientRequestMessages.organizationId, actor.organizationId)))
        .orderBy(asc(clientRequestMessages.createdAt));
      const attachments = new Map<string, { messageId: string; fileName: string; mimeType: string; fileSize: number }>();
      for (const { m } of msgs) {
        if (!m.attachmentReceiptId) continue;
        const stored = await PostgresDocumentStorageProvider.retrieve(tx, actor.organizationId, m.attachmentReceiptId);
        if (stored) attachments.set(m.id, { messageId: m.id, fileName: stored.fileName, mimeType: stored.mimeType, fileSize: stored.data.byteLength });
      }
      return {
        ...view(found.r, found.requestedByName, msgs.length),
        messages: msgs.map(({ m, authorName }) => ({
          id: m.id,
          authorName,
          authorSide: m.authorSide,
          body: m.body,
          attachment: attachments.get(m.id) ?? null,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    });
  },

  /**
   * Adds a message. Side CLIENT needs `client_request:respond`; side PRACTICE needs
   * `client_request:manage` AND the practice's ACTIVE consent. A client reply moves an OPEN request
   * to ANSWERED; a practice reply moves ANSWERED back to OPEN. Not allowed on a CLOSED request.
   */
  async reply(
    actor: Actor,
    requestId: string,
    input: { body: string; side: MessageSide; attachment?: { fileName: string; mimeType: string; data: Buffer }; practiceId?: string },
  ) {
    assertPermission(actor, input.side === "PRACTICE" ? "client_request:manage" : "client_request:respond");
    const body = input.body.trim();
    if (!body && !input.attachment) throw new ClientRequestValidationError("Write a message or attach a document.");
    if (body.length > 5000) throw new ClientRequestValidationError("The message must be 5000 characters or fewer.");
    if (input.attachment) assertValidDocumentUpload(input.attachment.mimeType, input.attachment.data);

    return withTenant(actor.organizationId, async (tx) => {
      const request = await loadRequest(tx, actor.organizationId, requestId, input.practiceId);
      if (request.status === "CLOSED") throw new ClientRequestClosedError();
      if (input.side === "PRACTICE") await activeConsent(tx, actor.organizationId, request.practiceId);

      let attachmentReceiptId: string | null = null;
      if (input.attachment) {
        const stored = await PostgresDocumentStorageProvider.store(tx, actor.organizationId, {
          uploadedById: actor.userId,
          fileName: input.attachment.fileName,
          mimeType: input.attachment.mimeType,
          data: input.attachment.data,
        });
        attachmentReceiptId = stored.id;
      }
      const [msg] = await tx
        .insert(clientRequestMessages)
        .values({
          organizationId: actor.organizationId,
          requestId,
          authorUserId: actor.userId,
          authorSide: input.side,
          body: body || "(attachment)",
          attachmentReceiptId,
        })
        .returning({ id: clientRequestMessages.id });

      const nextStatus: RequestStatus = input.side === "CLIENT" ? "ANSWERED" : request.status === "ANSWERED" ? "OPEN" : request.status;
      await tx.update(clientRequests).set({ status: nextStatus, updatedAt: new Date() }).where(eq(clientRequests.id, requestId));
      await AuditService.record(tx, actor, {
        action: input.side === "CLIENT" ? "client_request.answered" : "client_request.practice_replied",
        entityType: "ClientRequest",
        entityId: requestId,
        before: { status: request.status },
        after: { status: nextStatus },
        metadata: { messageId: msg!.id, hasAttachment: Boolean(attachmentReceiptId) },
      });
      return { messageId: msg!.id, status: nextStatus };
    });
  },

  async close(actor: Actor, requestId: string, opts: { practiceId?: string } = {}) {
    assertPermission(actor, "client_request:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const request = await loadRequest(tx, actor.organizationId, requestId, opts.practiceId);
      if (request.status === "CLOSED") return;
      await tx
        .update(clientRequests)
        .set({ status: "CLOSED", closedAt: new Date(), closedByUserId: actor.userId, updatedAt: new Date() })
        .where(eq(clientRequests.id, requestId));
      await AuditService.record(tx, actor, {
        action: "client_request.closed",
        entityType: "ClientRequest",
        entityId: requestId,
        before: { status: request.status },
        after: { status: "CLOSED" },
      });
    });
  },

  async reopen(actor: Actor, requestId: string, opts: { practiceId?: string } = {}) {
    assertPermission(actor, "client_request:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const request = await loadRequest(tx, actor.organizationId, requestId, opts.practiceId);
      if (request.status !== "CLOSED") return;
      await activeConsent(tx, actor.organizationId, request.practiceId);
      await tx
        .update(clientRequests)
        .set({ status: "OPEN", closedAt: null, closedByUserId: null, updatedAt: new Date() })
        .where(eq(clientRequests.id, requestId));
      await AuditService.record(tx, actor, {
        action: "client_request.reopened",
        entityType: "ClientRequest",
        entityId: requestId,
        before: { status: "CLOSED" },
        after: { status: "OPEN" },
      });
    });
  },

  /** The bytes of a message's attachment, for download. */
  async getAttachment(actor: Actor, requestId: string, messageId: string, opts: { practiceId?: string } = {}) {
    assertPermission(actor, "client_request:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ receiptId: clientRequestMessages.attachmentReceiptId, practiceId: clientRequests.practiceId })
        .from(clientRequestMessages)
        .innerJoin(clientRequests, eq(clientRequests.id, clientRequestMessages.requestId))
        .where(
          and(
            eq(clientRequestMessages.id, messageId),
            eq(clientRequestMessages.requestId, requestId),
            eq(clientRequestMessages.organizationId, actor.organizationId),
            opts.practiceId ? eq(clientRequests.practiceId, opts.practiceId) : undefined,
          ),
        );
      if (!row?.receiptId) throw new ClientRequestNotFoundError();
      const stored = await PostgresDocumentStorageProvider.retrieve(tx, actor.organizationId, row.receiptId);
      if (!stored) throw new ClientRequestNotFoundError();
      return stored;
    });
  },
};
