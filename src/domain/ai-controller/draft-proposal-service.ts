import "server-only";
import { and, eq, lt, ne } from "drizzle-orm";
import { aiDraftProposals } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { type Actor } from "@/domain/permissions/permission-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { CreateInvoiceInput } from "@/domain/sales/types";
import type { CreateBillInput } from "@/domain/purchases/types";
import type { JournalEntryDraft } from "@/domain/ledger/types";
import { AutonomySettingsService } from "./autonomy";

/**
 * The real human-in-the-loop checkpoint for every write-capable Controller
 * tool (`write-tools.ts`). A tool call NEVER creates an invoice/bill/journal
 * entry itself — it only resolves the model's request into a fully
 * validated creation payload and stores it here, PENDING. Only `confirm()`,
 * triggered by a separate, explicit user action in the chat UI (a distinct
 * "Create this draft?" click — see `confirm-draft-proposal-action.ts`),
 * calls the real `InvoiceService.create`/`BillService.create`/
 * `PostingService.createDraft` — the exact same DRAFT-only method a human
 * using the UI directly would call. See docs/ai-agents.md's "proposal vs.
 * confirmation" section for the full design rationale.
 */

export type DraftProposalType = "INVOICE" | "BILL" | "JOURNAL_ENTRY";
export type DraftProposalStatus = "PENDING" | "CONFIRMED" | "DISMISSED" | "EXPIRED";

/** The resolved, fully-validated creation payload for each proposal type. Dates are ISO strings (jsonb-safe). */
export type InvoiceProposalPayload = Omit<CreateInvoiceInput, "issueDate" | "dueDate"> & {
  issueDate: string;
  dueDate: string;
};
export type BillProposalPayload = Omit<CreateBillInput, "issueDate" | "dueDate"> & {
  issueDate: string;
  dueDate: string;
};
export type JournalEntryProposalPayload = Omit<JournalEntryDraft, "postingDate"> & {
  postingDate: string;
};

export type DraftProposalPayload = InvoiceProposalPayload | BillProposalPayload | JournalEntryProposalPayload;

export interface DraftProposalPreviewLine {
  description: string;
  quantity?: string;
  unitPrice?: string;
  debit?: string;
  credit?: string;
  accountLabel: string;
  amount?: string;
}

/** The human-readable shape the chat UI's confirmation card actually renders — never trusted for creation, only `payload` is. */
export interface DraftProposalPreview {
  type: DraftProposalType;
  headline: string;
  counterpartyName?: string;
  currency: string;
  total?: string;
  memo?: string;
  lines: DraftProposalPreviewLine[];
}

export interface StoredDraftProposal {
  id: string;
  type: DraftProposalType;
  status: DraftProposalStatus;
  preview: DraftProposalPreview;
  createdAt: string;
  expiresAt: string;
}

export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`Draft proposal ${id} was not found in this organization.`);
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalNotPendingError extends Error {
  constructor(id: string, status: DraftProposalStatus) {
    super(`Draft proposal ${id} is ${status}, not pending — it can no longer be confirmed.`);
    this.name = "ProposalNotPendingError";
  }
}

export class ProposalExpiredError extends Error {
  constructor(id: string) {
    super(`Draft proposal ${id} has expired — ask the Controller to prepare it again.`);
    this.name = "ProposalExpiredError";
  }
}

export class AutonomyLevelTooLowError extends Error {
  constructor() {
    super("This organization's AI autonomy level no longer allows preparing drafts (Level 2 required).");
    this.name = "AutonomyLevelTooLowError";
  }
}

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

function toStored(row: typeof aiDraftProposals.$inferSelect): StoredDraftProposal {
  return {
    id: row.id,
    type: row.proposalType,
    status: row.status,
    preview: row.preview as DraftProposalPreview,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export const AIDraftProposalService = {
  /**
   * Called from inside a write-capable tool's `execute()` — i.e. the model
   * decided to call the tool, but nothing has been created yet. `actor` here
   * may carry `type: "AI"` (it's recorded as the acting party for the
   * proposal's own audit row), but the real mutation this proposal may later
   * become is always created under the real human actor who clicks confirm,
   * never under this one.
   */
  async create(
    actor: Actor,
    params: {
      type: DraftProposalType;
      payload: DraftProposalPayload;
      preview: DraftProposalPreview;
      model: string;
      question: string;
    },
  ): Promise<StoredDraftProposal> {
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .insert(aiDraftProposals)
        .values({
          organizationId: actor.organizationId,
          proposalType: params.type,
          status: "PENDING",
          createdByUserId: actor.userId,
          model: params.model,
          conversationQuestion: params.question.slice(0, 2000),
          payload: params.payload as object,
          preview: params.preview as object,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        })
        .returning();
      if (!row) throw new Error("Failed to create draft proposal.");

      await AuditService.record(tx, { ...actor, type: "AI" }, {
        action: "ai_controller.draft_proposed",
        entityType: "AIDraftProposal",
        entityId: row.id,
        after: { proposalType: params.type, preview: params.preview, model: params.model, question: params.question },
      });

      return toStored(row);
    });
  },

  async get(actor: Actor, proposalId: string): Promise<StoredDraftProposal | null> {
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(aiDraftProposals)
        .where(and(eq(aiDraftProposals.id, proposalId), eq(aiDraftProposals.organizationId, actor.organizationId)));
      return row ? toStored(row) : null;
    });
  },

  /**
   * The ONLY path that turns a proposal into a real DRAFT invoice/bill/
   * journal entry. `actor` here is the real, authenticated user who clicked
   * "Create this draft?" — permission is enforced for real, at this actual
   * creation step, by the exact same `assertPermission` call the underlying
   * `InvoiceService.create`/`BillService.create`/`PostingService.createDraft`
   * already runs for a human using the UI directly. A restricted-role user
   * who somehow had a proposal shown to them (e.g. a teammate pasted it) is
   * refused here, exactly as they would be refused in the Sales/Purchases/
   * Journal UI — this is never a second, looser permission check.
   */
  async confirm(actor: Actor, proposalId: string): Promise<{ type: DraftProposalType; resultEntityId: string; resultLabel: string }> {
    const level = await AutonomySettingsService.getLevel(actor.organizationId);
    if (level < 2) {
      throw new AutonomyLevelTooLowError();
    }

    const proposal = await withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(aiDraftProposals)
        .where(and(eq(aiDraftProposals.id, proposalId), eq(aiDraftProposals.organizationId, actor.organizationId)));
      return row ?? null;
    });
    if (!proposal) throw new ProposalNotFoundError(proposalId);
    if (proposal.status !== "PENDING") throw new ProposalNotPendingError(proposalId, proposal.status);
    if (proposal.expiresAt.getTime() < Date.now()) {
      await markExpired(actor.organizationId, proposalId);
      throw new ProposalExpiredError(proposalId);
    }

    // The underlying domain-service `.create`/`.createDraft` call is the
    // real permission check and the real (and only) write — see this
    // module's doc comment. If it throws (e.g. PermissionDeniedError), this
    // propagates uncaught: the proposal stays PENDING and nothing was
    // recorded as confirmed, which is correct — nothing was created.
    let resultEntityId: string;
    let resultLabel: string;
    if (proposal.proposalType === "INVOICE") {
      const payload = proposal.payload as InvoiceProposalPayload;
      const result = await InvoiceService.create(actor, {
        ...payload,
        issueDate: new Date(payload.issueDate),
        dueDate: new Date(payload.dueDate),
      });
      resultEntityId = result.id;
      resultLabel = result.invoiceNumber;
    } else if (proposal.proposalType === "BILL") {
      const payload = proposal.payload as BillProposalPayload;
      const result = await BillService.create(actor, {
        ...payload,
        issueDate: new Date(payload.issueDate),
        dueDate: new Date(payload.dueDate),
      });
      resultEntityId = result.id;
      resultLabel = result.billNumber;
    } else {
      const payload = proposal.payload as JournalEntryProposalPayload;
      const result = await PostingService.createDraft(actor, {
        ...payload,
        postingDate: new Date(payload.postingDate),
      });
      resultEntityId = result.entryId;
      resultLabel = result.entryNumber;
    }

    await withTenant(actor.organizationId, async (tx) => {
      await tx
        .update(aiDraftProposals)
        .set({ status: "CONFIRMED", confirmedByUserId: actor.userId, confirmedAt: new Date(), resultEntityId })
        .where(eq(aiDraftProposals.id, proposalId));

      // Satisfies master spec §44's "for AI actions also store: agent,
      // model, ..., proposed action, approver, outcome" — the creation
      // itself is already audited (as HUMAN, by `actor`) inside
      // InvoiceService.create/BillService.create/PostingService.createDraft;
      // this is the separate record tying that human-authored draft back to
      // the AI proposal and the human who confirmed it.
      await AuditService.record(tx, actor, {
        action: "ai_controller.draft_confirmed",
        entityType: "AIDraftProposal",
        entityId: proposalId,
        before: { status: "PENDING" },
        after: { status: "CONFIRMED", resultEntityId, resultLabel },
        metadata: {
          proposedByUserId: proposal.createdByUserId,
          confirmedByUserId: actor.userId,
          model: proposal.model,
          proposalType: proposal.proposalType,
        },
      });
    });

    return { type: proposal.proposalType, resultEntityId, resultLabel };
  },

  async dismiss(actor: Actor, proposalId: string): Promise<void> {
    await withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(aiDraftProposals)
        .where(and(eq(aiDraftProposals.id, proposalId), eq(aiDraftProposals.organizationId, actor.organizationId)));
      if (!row || row.status !== "PENDING") return;

      await tx.update(aiDraftProposals).set({ status: "DISMISSED", dismissedAt: new Date() }).where(eq(aiDraftProposals.id, proposalId));

      await AuditService.record(tx, actor, {
        action: "ai_controller.draft_dismissed",
        entityType: "AIDraftProposal",
        entityId: proposalId,
        before: { status: "PENDING" },
        after: { status: "DISMISSED" },
      });
    });
  },

  /** Best-effort housekeeping: marks stale PENDING proposals EXPIRED so confirm() always has a fresh, auditable status. Never required for correctness — confirm() checks `expiresAt` itself regardless. */
  async expireStale(organizationId: string): Promise<void> {
    await withTenant(organizationId, async (tx) => {
      await tx
        .update(aiDraftProposals)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(aiDraftProposals.organizationId, organizationId),
            eq(aiDraftProposals.status, "PENDING"),
            lt(aiDraftProposals.expiresAt, new Date()),
          ),
        );
    });
  },
};

async function markExpired(organizationId: string, proposalId: string): Promise<void> {
  await withTenant(organizationId, async (tx: TenantDb) => {
    await tx
      .update(aiDraftProposals)
      .set({ status: "EXPIRED" })
      .where(and(eq(aiDraftProposals.id, proposalId), ne(aiDraftProposals.status, "CONFIRMED")));
  });
}
