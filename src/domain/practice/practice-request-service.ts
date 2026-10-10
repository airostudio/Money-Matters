import { withUserScope } from "@/db/user-scope";
import {
  ClientRequestService,
  type MessageSide,
  type RequestDetail,
  type RequestStatus,
  type RequestType,
  type RequestView,
} from "@/domain/client-requests/client-request-service";
import { requireClientActor } from "./client-access";
import { PracticeAccess } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { ClientLinkNotFoundError } from "./errors";
import { practiceClientLinks } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { PracticeActor } from "./types";

/**
 * The PRACTICE side of client queries and document requests. Nothing here touches a client
 * table directly: every call resolves the staff member's real membership in the client (and the
 * client's ACTIVE consent) with `requireClientActor`, then calls the client organization's own
 * `ClientRequestService` with that Actor — so the client's RBAC, not the practice link,
 * decides whether the staff member may raise or answer a request. The practice's own audit log
 * records the action (ids only, never the message text).
 */
export const PracticeRequestService = {
  async create(
    actor: PracticeActor,
    practiceId: string,
    clientOrganizationId: string,
    input: { type: RequestType; subject: string; body: string; dueDate?: string | null },
  ): Promise<RequestView> {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    const created = await ClientRequestService.create(clientActor, { practiceId, ...input });
    await audit(actor, practiceId, clientOrganizationId, "client_request.created", created.id, { type: input.type });
    return created;
  },

  async list(actor: PracticeActor, practiceId: string, clientOrganizationId: string, opts: { status?: RequestStatus } = {}): Promise<RequestView[]> {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    return ClientRequestService.list(clientActor, { practiceId, status: opts.status });
  },

  async get(actor: PracticeActor, practiceId: string, clientOrganizationId: string, requestId: string): Promise<RequestDetail> {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    return ClientRequestService.get(clientActor, requestId, { practiceId });
  },

  async reply(
    actor: PracticeActor,
    practiceId: string,
    clientOrganizationId: string,
    requestId: string,
    input: { body: string; attachment?: { fileName: string; mimeType: string; data: Buffer } },
  ) {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    const side: MessageSide = "PRACTICE";
    const result = await ClientRequestService.reply(clientActor, requestId, { ...input, side, practiceId });
    await audit(actor, practiceId, clientOrganizationId, "client_request.practice_replied", requestId, { hasAttachment: Boolean(input.attachment) });
    return result;
  },

  async close(actor: PracticeActor, practiceId: string, clientOrganizationId: string, requestId: string) {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    await ClientRequestService.close(clientActor, requestId, { practiceId });
    await audit(actor, practiceId, clientOrganizationId, "client_request.closed", requestId, {});
  },

  async reopen(actor: PracticeActor, practiceId: string, clientOrganizationId: string, requestId: string) {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    await ClientRequestService.reopen(clientActor, requestId, { practiceId });
    await audit(actor, practiceId, clientOrganizationId, "client_request.reopened", requestId, {});
  },

  async getAttachment(actor: PracticeActor, practiceId: string, clientOrganizationId: string, requestId: string, messageId: string) {
    const clientActor = await clientFor(actor, practiceId, clientOrganizationId);
    return ClientRequestService.getAttachment(clientActor, requestId, messageId, { practiceId });
  },
};

/** Practice membership, then the staff member's real client role with the client's consent re-checked. */
async function clientFor(actor: PracticeActor, practiceId: string, clientOrganizationId: string) {
  const link = await withUserScope(actor.userId, async (tx) => {
    await PracticeAccess.load(tx, actor, practiceId);
    const [row] = await tx
      .select({ clientName: practiceClientLinks.clientName })
      .from(practiceClientLinks)
      .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
    if (!row) throw new ClientLinkNotFoundError();
    return row;
  });
  return requireClientActor(actor.userId, practiceId, { organizationId: clientOrganizationId, name: link.clientName }, actor.type);
}

async function audit(actor: PracticeActor, practiceId: string, clientOrganizationId: string, action: string, entityId: string, extra: Record<string, unknown>) {
  await withUserScope(actor.userId, (tx) =>
    PracticeAuditService.record(tx, {
      practiceId,
      actorUserId: actor.userId,
      actorType: actor.type,
      action,
      entityType: "ClientRequest",
      entityId,
      metadata: { clientOrganizationId, ...extra },
    }),
  );
}
