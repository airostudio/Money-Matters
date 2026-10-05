import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  practiceClientLinks,
  practiceRoster,
  users,
  workpaperAdjustments,
  workpaperEvidence,
  workpaperReviewNotes,
  workpaperScheduleLines,
  workpaperSignoffs,
  workpaperSnapshots,
  workpapers,
} from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { PostgresPracticeEvidenceStorageProvider } from "@/domain/documents/storage-provider";
import { assertValidDocumentUpload } from "@/domain/documents/document-validation";
import { AccountService } from "@/domain/accounts/account-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { requireClientActor } from "./client-access";
import { PracticeAccess, practiceRoleAtLeast, type PracticeContext } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { LinkNotActiveError, PracticeValidationError } from "./errors";
import type { LinkStatus, PracticeActor } from "./types";
import {
  compareSnapshotToLedger,
  evaluateReviewerSignoff,
  parseAmount,
  planCarryForward,
  reconcile,
  suggestNextPeriodEnd,
  type CarryForwardPlan,
  type ReconciliationResult,
  type ScheduleLine,
  type ScheduleLineKind,
} from "./workpaper-math";

export type WorkpaperStatus = "DRAFT" | "IN_REVIEW" | "SIGNED_OFF";

export class WorkpaperNotFoundError extends Error {
  constructor() {
    super("That workpaper does not exist in this practice.");
    this.name = "WorkpaperNotFoundError";
  }
}

export class WorkpaperStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkpaperStateError";
  }
}

export class DuplicateWorkpaperError extends Error {
  constructor() {
    super("A workpaper for that account and period already exists for this client.");
    this.name = "DuplicateWorkpaperError";
  }
}

export class NotABalanceSheetAccountError extends Error {
  constructor(type: string) {
    super(`Account reconciliation workpapers are for balance-sheet accounts (asset, liability or equity); this is a ${type.toLowerCase()} account.`);
    this.name = "NotABalanceSheetAccountError";
  }
}

export class SignoffRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignoffRuleError";
  }
}

export interface CreateWorkpaperInput {
  clientOrganizationId: string;
  accountId: string;
  /** The balance is "as at the end of this day" (YYYY-MM-DD). */
  periodEnd: string;
}

export interface ScheduleLineInput {
  kind: ScheduleLineKind;
  description: string;
  reference?: string;
  amount: string;
  isRecurring?: boolean;
}

export interface WorkpaperSummary {
  id: string;
  clientOrganizationId: string;
  clientName: string;
  linkStatus: LinkStatus | null;
  accountCode: string;
  accountName: string;
  periodEnd: string;
  status: WorkpaperStatus;
  version: number;
  preparedByName: string;
  ledgerBalance: string;
  snapshotTakenAt: string;
  openNotes: number;
}

export interface Freshness {
  /** False when the live check could not be made (client access ended, not a member, error) — see `reason`. */
  checked: boolean;
  stale: boolean;
  currentBalance?: string;
  /** current - snapshot. */
  change?: string;
  reason?: string;
}

export interface WorkpaperDetail {
  workpaper: WorkpaperSummary & {
    accountId: string;
    accountType: string;
    currency: string;
    preparedByUserId: string;
    snapshotTakenByName: string;
    priorPeriodEnd: string | null;
    priorLedgerBalance: string | null;
    priorWorkpaperId: string | null;
  };
  lines: Array<ScheduleLineInput & { id: string; lineNumber: number }>;
  reconciliation: ReconciliationResult;
  evidence: Array<{ id: string; fileName: string; mimeType: string; fileSize: number; description: string | null; uploadedByName: string; createdAt: string }>;
  adjustments: Array<{
    id: string;
    description: string;
    debitAccount: string | null;
    creditAccount: string | null;
    amount: string;
    status: "PROPOSED" | "DISMISSED" | "POSTED";
    postedReference: string | null;
    createdByName: string;
  }>;
  notes: Array<{
    id: string;
    version: number;
    body: string;
    status: "OPEN" | "RESOLVED";
    authorName: string;
    resolvedByName: string | null;
    resolvedAt: string | null;
    resolutionComment: string | null;
    createdAt: string;
  }>;
  signoffs: Array<{ id: string; version: number; step: "PREPARER" | "REVIEWER" | "REOPEN"; userName: string; practiceRole: string; reason: string | null; singleStaffException: boolean; createdAt: string }>;
  snapshots: Array<{ id: string; version: number; periodEnd: string; ledgerBalance: string; takenAt: string; takenByName: string; takenByRole: string }>;
  freshness: Freshness;
  /** Plain statement of where the figures came from — shown above them. */
  provenance: string;
  /** Set when the client has ended this practice's access: the paper is retained as of its snapshot date. */
  retentionNote: string | null;
}

function ymdValid(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** The end of the period's last day, UTC — the instant the ledger balance is read "as at". */
export function endOfDay(periodEnd: string): Date {
  return new Date(`${periodEnd}T23:59:59.999Z`);
}

function cleanLines(lines: ScheduleLineInput[]): ScheduleLine[] {
  if (lines.length > 100) throw new PracticeValidationError("A schedule can have at most 100 lines.");
  return lines.map((l) => {
    const description = l.description.trim();
    if (!description) throw new PracticeValidationError("Every schedule line needs a description.");
    if (description.length > 200) throw new PracticeValidationError("A schedule line description must be 200 characters or fewer.");
    if (l.kind !== "SUPPORTING_BALANCE" && l.kind !== "RECONCILING_ITEM") throw new PracticeValidationError("Unknown schedule line type.");
    return {
      kind: l.kind,
      description,
      reference: l.reference?.trim() || null,
      amount: parseAmount(l.amount).toFixed(4),
      isRecurring: Boolean(l.isRecurring),
    };
  });
}

/**
 * Digital working papers (master spec s.43): balance-sheet account reconciliation.
 *
 * Everything here belongs to the PRACTICE (practice-scoped tables, reached with
 * `withUserScope`); the CLIENT's books are touched in exactly one way — a read of
 * one account's balance, made through the client's own `LedgerService` inside
 * `withTenant(clientId)` with the staff member's REAL role there, after the client's
 * own consent record has been re-checked (requireClientActor). A workpaper NEVER
 * writes to a client's ledger: a proposed adjustment is a note, and posting it is a
 * separate act the accountant performs through the client's normal journal flow.
 *
 * The balance is a POINT-IN-TIME SNAPSHOT: stored with who pulled it and when, with a
 * history row per pull, labelled "per ledger as at <date>, pulled <timestamp>". The
 * detail view makes ONE extra single-account query to warn when the ledger has moved
 * since (staleness). Creating, refreshing and carrying forward need live client access;
 * everything else (schedule, evidence, notes, sign-off) is the practice's own record and
 * keeps working after a client revokes access — shown as of the snapshot date.
 *
 * Lifecycle: DRAFT -> (preparer signs) IN_REVIEW -> (reviewer signs) SIGNED_OFF. A signed-off
 * paper is immutable — the database refuses any change to its schedule, evidence, notes and
 * adjustments, and the sign-off history is append-only; a correction is a REOPEN with a
 * reason, which bumps the version and returns it to DRAFT. The reviewer must not be the
 * preparer wherever the practice has two or more active staff (single-staff exception,
 * flagged in the history). Every mutation is audited.
 */
export const WorkpaperService = {
  async create(actor: PracticeActor, practiceId: string, input: CreateWorkpaperInput, now: Date = new Date()): Promise<{ id: string }> {
    return createWorkpaper(actor, practiceId, input, now, null);
  },

  /**
   * The balance-sheet accounts of a client's chart, for the "new workpaper" picker — read with the staff
   * member's real role in the client (needs `account:read` there) after the consent check.
   */
  async listClientAccounts(actor: PracticeActor, practiceId: string, clientOrganizationId: string) {
    const clientName = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const [row] = await tx
        .select({ clientName: practiceClientLinks.clientName })
        .from(practiceClientLinks)
        .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
      if (!row) throw new LinkNotActiveError();
      return row.clientName;
    });
    const clientActor = await requireClientActor(actor.userId, practiceId, { organizationId: clientOrganizationId, name: clientName }, actor.type);
    const accounts = await AccountService.list(clientActor);
    return accounts
      .filter((a) => a.type === "ASSET" || a.type === "LIABILITY" || a.type === "EQUITY")
      .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }));
  },

  async list(actor: PracticeActor, practiceId: string, opts: { clientOrganizationId?: string; status?: WorkpaperStatus } = {}): Promise<WorkpaperSummary[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const rows = await tx
        .select({
          w: workpapers,
          clientName: practiceClientLinks.clientName,
          linkStatus: practiceClientLinks.status,
          preparedByName: users.name,
          openNotes: sql<number>`(select count(*)::int from workpaper_review_notes n where n.workpaper_id = ${workpapers.id} and n.status = 'OPEN')`,
        })
        .from(workpapers)
        .innerJoin(
          practiceClientLinks,
          and(eq(practiceClientLinks.practiceId, workpapers.practiceId), eq(practiceClientLinks.clientOrganizationId, workpapers.clientOrganizationId)),
        )
        .innerJoin(users, eq(users.id, workpapers.preparedByUserId))
        .where(
          and(
            eq(workpapers.practiceId, practiceId),
            opts.clientOrganizationId ? eq(workpapers.clientOrganizationId, opts.clientOrganizationId) : undefined,
            opts.status ? eq(workpapers.status, opts.status) : undefined,
          ),
        )
        .orderBy(desc(workpapers.periodEnd), asc(practiceClientLinks.clientName), asc(workpapers.accountCode))
        .limit(200);
      return rows.map((r) => summary(r.w, r.clientName, r.linkStatus, r.preparedByName, Number(r.openNotes)));
    });
  },

  /** The full workpaper, plus ONE single-account freshness check against the client's ledger (when access allows). */
  async get(actor: PracticeActor, practiceId: string, workpaperId: string): Promise<WorkpaperDetail> {
    const base = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      return loadDetail(tx, practiceId, workpaperId);
    });
    const freshness = await checkFreshness(actor, practiceId, base);
    return { ...base, freshness };
  },

  /** Pulls a fresh balance (a new snapshot). Needs live client access; refused once SIGNED_OFF. */
  async refreshSnapshot(actor: PracticeActor, practiceId: string, workpaperId: string, now: Date = new Date()) {
    const wp = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const row = await loadWorkpaper(tx, practiceId, workpaperId);
      if (row.status === "SIGNED_OFF") throw new WorkpaperStateError("A signed-off workpaper cannot be changed. Reopen it (with a reason) first.");
      if (row.status === "IN_REVIEW") throw new WorkpaperStateError("Return the workpaper to draft before refreshing its balance, so the review is not left standing on stale figures.");
      return row;
    });
    const pulled = await pullBalance(actor, practiceId, wp.clientOrganizationId, wp.accountId, wp.periodEnd);
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const locked = await lockWorkpaper(tx, practiceId, workpaperId);
      if (locked.status !== "DRAFT") throw new WorkpaperStateError("The workpaper changed state while the balance was being pulled — reload and try again.");
      await tx
        .update(workpapers)
        .set({ ledgerBalance: pulled.balance, snapshotTakenAt: now, snapshotTakenByUserId: actor.userId, updatedAt: now })
        .where(eq(workpapers.id, workpaperId));
      await tx.insert(workpaperSnapshots).values({
        workpaperId,
        practiceId,
        version: locked.version,
        periodEnd: locked.periodEnd,
        ledgerBalance: pulled.balance,
        takenAt: now,
        takenByUserId: actor.userId,
        takenByRole: pulled.role,
      });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.snapshot_refreshed",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { ledgerBalance: locked.ledgerBalance, takenAt: locked.snapshotTakenAt.toISOString() },
        after: { ledgerBalance: pulled.balance, takenAt: now.toISOString() },
        metadata: { roleUsed: pulled.role, practiceRole: ctx.role },
      });
    });
  },

  /** Replaces the whole supporting schedule (DRAFT only; the database refuses it once SIGNED_OFF). */
  async setSchedule(actor: PracticeActor, practiceId: string, workpaperId: string, lines: ScheduleLineInput[]) {
    const clean = cleanLines(lines);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT");
      const before = await tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, workpaperId)).orderBy(asc(workpaperScheduleLines.lineNumber));
      await tx.delete(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, workpaperId));
      let n = 0;
      for (const l of clean) {
        n += 1;
        await tx.insert(workpaperScheduleLines).values({
          workpaperId,
          practiceId,
          lineNumber: n,
          kind: l.kind,
          description: l.description,
          reference: l.reference ?? null,
          amount: l.amount,
          isRecurring: l.isRecurring ?? false,
        });
      }
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.schedule_updated",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: before.map((b) => ({ kind: b.kind, description: b.description, amount: b.amount })),
        after: clean.map((c) => ({ kind: c.kind, description: c.description, amount: c.amount })),
      });
      return reconcile(wp.ledgerBalance, clean, wp.currency);
    });
  },

  // ------------------------------------------------------------------ evidence

  async addEvidence(
    actor: PracticeActor,
    practiceId: string,
    workpaperId: string,
    input: { fileName: string; mimeType: string; data: Buffer; description?: string },
  ) {
    // The same MIME / size / emptiness rules the receipt upload applies.
    assertValidDocumentUpload(input.mimeType, input.data);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const stored = await PostgresPracticeEvidenceStorageProvider.store(tx, practiceId, {
        workpaperId,
        uploadedById: actor.userId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        data: input.data,
        description: input.description?.trim() || null,
      });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.evidence_added",
        entityType: "Workpaper",
        entityId: workpaperId,
        after: { fileName: stored.fileName, mimeType: stored.mimeType, fileSize: stored.fileSize },
      });
      return stored;
    });
  },

  async getEvidenceFile(actor: PracticeActor, practiceId: string, evidenceId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      return PostgresPracticeEvidenceStorageProvider.retrieve(tx, practiceId, evidenceId);
    });
  },

  async removeEvidence(actor: PracticeActor, practiceId: string, workpaperId: string, evidenceId: string) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const [ev] = await tx
        .select({ fileName: workpaperEvidence.fileName })
        .from(workpaperEvidence)
        .where(and(eq(workpaperEvidence.id, evidenceId), eq(workpaperEvidence.workpaperId, workpaperId)));
      if (!ev) throw new PracticeValidationError("That evidence file does not exist on this workpaper.");
      await tx.delete(workpaperEvidence).where(eq(workpaperEvidence.id, evidenceId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.evidence_removed",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { fileName: ev.fileName },
      });
    });
  },

  // --------------------------------------------------------------- adjustments

  /** Records a PROPOSED adjustment as a note. It is never posted to the client's ledger by this system. */
  async proposeAdjustment(
    actor: PracticeActor,
    practiceId: string,
    workpaperId: string,
    input: { description: string; amount: string; debitAccount?: string; creditAccount?: string },
  ) {
    const description = input.description.trim();
    if (!description) throw new PracticeValidationError("An adjustment needs a description.");
    const amount = parseAmount(input.amount).toFixed(4);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const [row] = await tx
        .insert(workpaperAdjustments)
        .values({
          workpaperId,
          practiceId,
          description,
          amount,
          debitAccount: input.debitAccount?.trim() || null,
          creditAccount: input.creditAccount?.trim() || null,
          createdByUserId: actor.userId,
        })
        .returning({ id: workpaperAdjustments.id });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.adjustment_proposed",
        entityType: "Workpaper",
        entityId: workpaperId,
        after: { description, amount, debitAccount: input.debitAccount ?? null, creditAccount: input.creditAccount ?? null },
        metadata: { posted: false },
      });
      return row!;
    });
  },

  /** Marks a proposal dismissed, or "posted" with the reference the accountant entered (not verified against the ledger). */
  async setAdjustmentStatus(
    actor: PracticeActor,
    practiceId: string,
    workpaperId: string,
    adjustmentId: string,
    status: "PROPOSED" | "DISMISSED" | "POSTED",
    postedReference?: string,
  ) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const [before] = await tx
        .select()
        .from(workpaperAdjustments)
        .where(and(eq(workpaperAdjustments.id, adjustmentId), eq(workpaperAdjustments.workpaperId, workpaperId)));
      if (!before) throw new PracticeValidationError("That adjustment does not exist on this workpaper.");
      await tx
        .update(workpaperAdjustments)
        .set({ status, postedReference: status === "POSTED" ? postedReference?.trim() || null : null, updatedAt: new Date() })
        .where(eq(workpaperAdjustments.id, adjustmentId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.adjustment_status",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { status: before.status },
        after: { status, postedReference: postedReference ?? null },
        metadata: { postedByThisSystem: false },
      });
    });
  },

  // -------------------------------------------------------------- review notes

  async addReviewNote(actor: PracticeActor, practiceId: string, workpaperId: string, body: string) {
    const text = body.trim();
    if (!text) throw new PracticeValidationError("A review note cannot be empty.");
    if (text.length > 2000) throw new PracticeValidationError("A review note must be 2000 characters or fewer.");
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const [row] = await tx
        .insert(workpaperReviewNotes)
        .values({ workpaperId, practiceId, version: wp.version, body: text, authorUserId: actor.userId })
        .returning({ id: workpaperReviewNotes.id });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.review_note_added",
        entityType: "Workpaper",
        entityId: workpaperId,
        after: { noteId: row!.id, version: wp.version },
      });
      return row!;
    });
  },

  /** Clears (resolves) a note. The note and its text stay in the history. */
  async resolveReviewNote(actor: PracticeActor, practiceId: string, workpaperId: string, noteId: string, comment?: string) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      assertEditable(wp.status, "DRAFT or IN_REVIEW", true);
      const [note] = await tx
        .select()
        .from(workpaperReviewNotes)
        .where(and(eq(workpaperReviewNotes.id, noteId), eq(workpaperReviewNotes.workpaperId, workpaperId)));
      if (!note) throw new PracticeValidationError("That review note does not exist on this workpaper.");
      if (note.status === "RESOLVED") return;
      await tx
        .update(workpaperReviewNotes)
        .set({ status: "RESOLVED", resolvedByUserId: actor.userId, resolvedAt: new Date(), resolutionComment: comment?.trim() || null })
        .where(eq(workpaperReviewNotes.id, noteId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.review_note_resolved",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { status: "OPEN" },
        after: { status: "RESOLVED", noteId },
      });
    });
  },

  // ------------------------------------------------------------------- sign-off

  /** The preparer signs: DRAFT -> IN_REVIEW. */
  async signAsPreparer(actor: PracticeActor, practiceId: string, workpaperId: string, opts: { acknowledgeDifference?: boolean } = {}) {
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      if (wp.status !== "DRAFT") throw new WorkpaperStateError("Only a draft workpaper can be signed by its preparer.");
      if (wp.preparedByUserId !== actor.userId) throw new SignoffRuleError("Only the person who prepared this workpaper can sign as its preparer.");
      const rec = await currentReconciliation(tx, wp);
      assertDifferenceHandled(rec, opts.acknowledgeDifference);
      await tx.update(workpapers).set({ status: "IN_REVIEW", updatedAt: new Date() }).where(eq(workpapers.id, workpaperId));
      await tx.insert(workpaperSignoffs).values({ workpaperId, practiceId, version: wp.version, step: "PREPARER", userId: actor.userId, practiceRole: ctx.role });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.preparer_signed",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { status: "DRAFT" },
        after: { status: "IN_REVIEW", version: wp.version },
        metadata: { difference: rec.difference, differenceAcknowledged: !rec.isReconciled },
      });
    });
  },

  /**
   * The reviewer signs: IN_REVIEW -> SIGNED_OFF. Refused while any review note is open. The
   * reviewer must differ from the preparer unless the practice has a single active staff member.
   */
  async signAsReviewer(actor: PracticeActor, practiceId: string, workpaperId: string, opts: { acknowledgeDifference?: boolean } = {}) {
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      if (wp.status !== "IN_REVIEW") throw new WorkpaperStateError("The preparer must sign first; only a workpaper in review can be signed off.");

      const [{ n: activeStaff } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(practiceRoster)
        .where(and(eq(practiceRoster.practiceId, practiceId), eq(practiceRoster.status, "ACTIVE")));
      const rule = evaluateReviewerSignoff({ preparerUserId: wp.preparedByUserId, signerUserId: actor.userId, activeStaffCount: Number(activeStaff) });
      if (!rule.allowed) throw new SignoffRuleError(rule.reason ?? "Not allowed.");

      const [{ n: open } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(workpaperReviewNotes)
        .where(and(eq(workpaperReviewNotes.workpaperId, workpaperId), eq(workpaperReviewNotes.status, "OPEN")));
      if (Number(open) > 0) throw new SignoffRuleError(`${open} review note${Number(open) === 1 ? " is" : "s are"} still open — resolve them before signing off.`);

      const rec = await currentReconciliation(tx, wp);
      assertDifferenceHandled(rec, opts.acknowledgeDifference);

      await tx.insert(workpaperSignoffs).values({
        workpaperId,
        practiceId,
        version: wp.version,
        step: "REVIEWER",
        userId: actor.userId,
        practiceRole: ctx.role,
        singleStaffException: rule.singleStaffException,
      });
      await tx.update(workpapers).set({ status: "SIGNED_OFF", updatedAt: new Date() }).where(eq(workpapers.id, workpaperId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.reviewer_signed",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { status: "IN_REVIEW" },
        after: { status: "SIGNED_OFF", version: wp.version },
        metadata: { difference: rec.difference, differenceAcknowledged: !rec.isReconciled, singleStaffException: rule.singleStaffException },
      });
    });
  },

  /**
   * Reopens a workpaper WITH A REASON (mandatory). IN_REVIEW -> DRAFT by any member; a SIGNED_OFF
   * paper needs MANAGER+ and starts a NEW VERSION (the earlier version's sign-offs and notes stay
   * in the append-only history).
   */
  async reopen(actor: PracticeActor, practiceId: string, workpaperId: string, reason: string) {
    const why = reason.trim();
    if (why.length < 5) throw new PracticeValidationError("A reason (at least a few words) is required to reopen a workpaper.");
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const wp = await lockWorkpaper(tx, practiceId, workpaperId);
      if (wp.status === "DRAFT") throw new WorkpaperStateError("The workpaper is already a draft.");
      if (wp.status === "SIGNED_OFF" && !practiceRoleAtLeast(ctx.role, "MANAGER")) {
        await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Reopening a signed-off workpaper");
      }
      const nextVersion = wp.status === "SIGNED_OFF" ? wp.version + 1 : wp.version;
      await tx.update(workpapers).set({ status: "DRAFT", version: nextVersion, updatedAt: new Date() }).where(eq(workpapers.id, workpaperId));
      await tx.insert(workpaperSignoffs).values({ workpaperId, practiceId, version: nextVersion, step: "REOPEN", userId: actor.userId, practiceRole: ctx.role, reason: why });
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "workpaper.reopened",
        entityType: "Workpaper",
        entityId: workpaperId,
        before: { status: wp.status, version: wp.version },
        after: { status: "DRAFT", version: nextVersion },
        metadata: { reason: why },
      });
      return { version: nextVersion };
    });
  },

  // -------------------------------------------------------------- carry-forward

  /**
   * Creates the NEXT period's workpaper from a SIGNED-OFF one: the schedule structure and
   * recurring lines are copied (planCarryForward), the prior balance is shown as the
   * comparative, and a fresh balance is pulled for the new period. Evidence, sign-offs, review
   * notes, adjustments and the old snapshot are NEVER copied.
   */
  async carryForward(actor: PracticeActor, practiceId: string, sourceWorkpaperId: string, opts: { periodEnd?: string } = {}, now: Date = new Date()) {
    const source = await withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const wp = await loadWorkpaper(tx, practiceId, sourceWorkpaperId);
      if (wp.status !== "SIGNED_OFF") throw new WorkpaperStateError("Only a signed-off workpaper can be carried forward.");
      const lines = await tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, sourceWorkpaperId)).orderBy(asc(workpaperScheduleLines.lineNumber));
      return { wp, lines };
    });
    const periodEnd = opts.periodEnd ?? suggestNextPeriodEnd(source.wp.periodEnd);
    if (!ymdValid(periodEnd) || periodEnd <= source.wp.periodEnd) throw new PracticeValidationError("The new period must end after the signed-off one.");
    const plan: CarryForwardPlan = planCarryForward({
      periodEnd: source.wp.periodEnd,
      ledgerBalance: source.wp.ledgerBalance,
      lines: source.lines.map((l) => ({ kind: l.kind, description: l.description, reference: l.reference, amount: l.amount, isRecurring: l.isRecurring })),
    });
    const created = await createWorkpaper(
      actor,
      practiceId,
      { clientOrganizationId: source.wp.clientOrganizationId, accountId: source.wp.accountId, periodEnd },
      now,
      { sourceWorkpaperId, plan },
    );
    return { ...created, disposition: plan.disposition };
  },
};

// ---------------------------------------------------------------------------- internals

async function createWorkpaper(
  actor: PracticeActor,
  practiceId: string,
  input: CreateWorkpaperInput,
  now: Date,
  carry: { sourceWorkpaperId: string; plan: CarryForwardPlan } | null,
): Promise<{ id: string }> {
  if (!ymdValid(input.periodEnd)) throw new PracticeValidationError("The period end must be a date (YYYY-MM-DD).");
  const link = await withUserScope(actor.userId, async (tx) => {
    await PracticeAccess.load(tx, actor, practiceId);
    const [row] = await tx
      .select()
      .from(practiceClientLinks)
      .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, input.clientOrganizationId)));
    if (!row) throw new LinkNotActiveError();
    if (row.status !== "ACTIVE") throw new LinkNotActiveError();
    const [dupe] = await tx
      .select({ id: workpapers.id })
      .from(workpapers)
      .where(
        and(
          eq(workpapers.practiceId, practiceId),
          eq(workpapers.clientOrganizationId, input.clientOrganizationId),
          eq(workpapers.accountId, input.accountId),
          eq(workpapers.periodEnd, input.periodEnd),
        ),
      );
    if (dupe) throw new DuplicateWorkpaperError();
    return row;
  });

  const pulled = await pullBalance(actor, practiceId, input.clientOrganizationId, input.accountId, input.periodEnd, link.clientName);

  return withUserScope(actor.userId, async (tx) => {
    const ctx = await PracticeAccess.load(tx, actor, practiceId);
    let row: { id: string } | undefined;
    try {
      [row] = await tx
        .insert(workpapers)
        .values({
          practiceId,
          clientOrganizationId: input.clientOrganizationId,
          accountId: input.accountId,
          accountCode: pulled.code,
          accountName: pulled.name,
          accountType: pulled.type,
          currency: pulled.currency,
          periodEnd: input.periodEnd,
          preparedByUserId: actor.userId,
          ledgerBalance: pulled.balance,
          snapshotTakenAt: now,
          snapshotTakenByUserId: actor.userId,
          priorWorkpaperId: carry?.sourceWorkpaperId ?? null,
          priorPeriodEnd: carry?.plan.priorPeriodEnd ?? null,
          priorLedgerBalance: carry?.plan.priorLedgerBalance ?? null,
        })
        .returning({ id: workpapers.id });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code === "23505") throw new DuplicateWorkpaperError();
      throw error;
    }
    const id = row!.id;
    await tx.insert(workpaperSnapshots).values({
      workpaperId: id,
      practiceId,
      version: 1,
      periodEnd: input.periodEnd,
      ledgerBalance: pulled.balance,
      takenAt: now,
      takenByUserId: actor.userId,
      takenByRole: pulled.role,
    });
    let n = 0;
    for (const l of carry?.plan.lines ?? []) {
      n += 1;
      await tx.insert(workpaperScheduleLines).values({
        workpaperId: id,
        practiceId,
        lineNumber: n,
        kind: l.kind,
        description: l.description,
        reference: l.reference ?? null,
        amount: l.amount,
        isRecurring: l.isRecurring ?? false,
      });
    }
    await PracticeAuditService.record(tx, {
      practiceId,
      actorUserId: actor.userId,
      actorType: actor.type,
      action: carry ? "workpaper.carried_forward" : "workpaper.created",
      entityType: "Workpaper",
      entityId: id,
      after: { clientOrganizationId: input.clientOrganizationId, account: `${pulled.code} ${pulled.name}`, periodEnd: input.periodEnd, ledgerBalance: pulled.balance },
      metadata: {
        roleUsed: pulled.role,
        practiceRole: ctx.role,
        ...(carry ? { sourceWorkpaperId: carry.sourceWorkpaperId, disposition: carry.plan.disposition } : {}),
      },
    });
    return { id };
  });
}

/**
 * The ONLY read of client data a workpaper makes: one account's balance as at the end of the
 * period. Re-checks the staff member's real membership AND the client's consent first, requires
 * `financial_report:read` and `journal:read` in that client, and returns the balance in the
 * account's normal direction.
 */
async function pullBalance(
  actor: PracticeActor,
  practiceId: string,
  clientOrganizationId: string,
  accountId: string,
  periodEnd: string,
  clientName = "this client",
) {
  const clientActor: Actor = await requireClientActor(actor.userId, practiceId, { organizationId: clientOrganizationId, name: clientName }, actor.type);
  assertPermission(clientActor, "financial_report:read");
  assertPermission(clientActor, "journal:read");
  const result = await LedgerService.getAccountBalance(clientActor, accountId, endOfDay(periodEnd));
  if (!["ASSET", "LIABILITY", "EQUITY"].includes(result.type)) throw new NotABalanceSheetAccountError(result.type);
  return { ...result, role: clientActor.role };
}

async function checkFreshness(
  actor: PracticeActor,
  practiceId: string,
  detail: Omit<WorkpaperDetail, "freshness">,
): Promise<Freshness> {
  const wp = detail.workpaper;
  if (detail.retentionNote) return { checked: false, stale: false, reason: detail.retentionNote };
  try {
    const clientActor = await requireClientActor(actor.userId, practiceId, { organizationId: wp.clientOrganizationId, name: wp.clientName }, actor.type);
    assertPermission(clientActor, "journal:read");
    const current = await LedgerService.getAccountBalance(clientActor, wp.accountId, endOfDay(wp.periodEnd));
    const cmp = compareSnapshotToLedger(wp.ledgerBalance, current.balance, wp.currency);
    return { checked: true, stale: cmp.stale, currentBalance: current.balance, change: cmp.change };
  } catch (error) {
    return { checked: false, stale: false, reason: error instanceof Error ? error.message : "The live balance could not be checked." };
  }
}

function summary(w: typeof workpapers.$inferSelect, clientName: string, linkStatus: LinkStatus | null, preparedByName: string, openNotes: number): WorkpaperSummary {
  return {
    id: w.id,
    clientOrganizationId: w.clientOrganizationId,
    clientName,
    linkStatus,
    accountCode: w.accountCode,
    accountName: w.accountName,
    periodEnd: w.periodEnd,
    status: w.status,
    version: w.version,
    preparedByName,
    ledgerBalance: parseAmount(w.ledgerBalance).toFixed(2),
    snapshotTakenAt: w.snapshotTakenAt.toISOString(),
    openNotes,
  };
}

async function loadWorkpaper(tx: UserScopeDb, practiceId: string, workpaperId: string) {
  const [row] = await tx.select().from(workpapers).where(and(eq(workpapers.id, workpaperId), eq(workpapers.practiceId, practiceId)));
  if (!row) throw new WorkpaperNotFoundError();
  return row;
}

/** Row-locks the workpaper for the rest of the transaction — serialises concurrent edits and sign-offs. */
async function lockWorkpaper(tx: UserScopeDb, practiceId: string, workpaperId: string) {
  const [row] = await tx
    .select()
    .from(workpapers)
    .where(and(eq(workpapers.id, workpaperId), eq(workpapers.practiceId, practiceId)))
    .for("update");
  if (!row) throw new WorkpaperNotFoundError();
  return row;
}

function assertEditable(status: WorkpaperStatus, allowed: string, allowReview = false) {
  if (status === "SIGNED_OFF") throw new WorkpaperStateError("A signed-off workpaper cannot be changed. Reopen it (with a reason) to make a correction.");
  if (status === "IN_REVIEW" && !allowReview) throw new WorkpaperStateError(`This can only be changed while the workpaper is ${allowed}. Return it to draft first.`);
}

async function currentReconciliation(tx: UserScopeDb, wp: typeof workpapers.$inferSelect): Promise<ReconciliationResult> {
  const lines = await tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, wp.id));
  if (lines.length === 0) throw new SignoffRuleError("Add at least one supporting schedule line (for example the bank statement balance) before signing.");
  return reconcile(wp.ledgerBalance, lines.map((l) => ({ kind: l.kind, description: l.description, amount: l.amount })), wp.currency);
}

function assertDifferenceHandled(rec: ReconciliationResult, acknowledged?: boolean) {
  if (!rec.isReconciled && !acknowledged) {
    throw new SignoffRuleError(`The schedule does not agree to the ledger (difference ${rec.difference}). Resolve it, or explicitly acknowledge the unresolved difference when signing.`);
  }
}

async function loadDetail(tx: UserScopeDb, practiceId: string, workpaperId: string): Promise<Omit<WorkpaperDetail, "freshness">> {
  const wp = await loadWorkpaper(tx, practiceId, workpaperId);
  const [link] = await tx
    .select()
    .from(practiceClientLinks)
    .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, wp.clientOrganizationId)));
  const nameOf = new Map<string, string>();
  const userIds = new Set<string>([wp.preparedByUserId, wp.snapshotTakenByUserId]);

  const lines = await tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, workpaperId)).orderBy(asc(workpaperScheduleLines.lineNumber));
  const evidence = await tx
    .select({
      id: workpaperEvidence.id,
      fileName: workpaperEvidence.fileName,
      mimeType: workpaperEvidence.mimeType,
      fileSize: workpaperEvidence.fileSize,
      description: workpaperEvidence.description,
      uploadedByUserId: workpaperEvidence.uploadedByUserId,
      createdAt: workpaperEvidence.createdAt,
    })
    .from(workpaperEvidence)
    .where(eq(workpaperEvidence.workpaperId, workpaperId))
    .orderBy(asc(workpaperEvidence.createdAt));
  const adjustments = await tx.select().from(workpaperAdjustments).where(eq(workpaperAdjustments.workpaperId, workpaperId)).orderBy(asc(workpaperAdjustments.createdAt));
  const notes = await tx.select().from(workpaperReviewNotes).where(eq(workpaperReviewNotes.workpaperId, workpaperId)).orderBy(asc(workpaperReviewNotes.createdAt));
  const signoffs = await tx.select().from(workpaperSignoffs).where(eq(workpaperSignoffs.workpaperId, workpaperId)).orderBy(asc(workpaperSignoffs.createdAt));
  const snapshots = await tx.select().from(workpaperSnapshots).where(eq(workpaperSnapshots.workpaperId, workpaperId)).orderBy(asc(workpaperSnapshots.takenAt));

  for (const e of evidence) userIds.add(e.uploadedByUserId);
  for (const a of adjustments) userIds.add(a.createdByUserId);
  for (const n of notes) {
    userIds.add(n.authorUserId);
    if (n.resolvedByUserId) userIds.add(n.resolvedByUserId);
  }
  for (const s of signoffs) userIds.add(s.userId);
  for (const s of snapshots) userIds.add(s.takenByUserId);
  const people = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds]));
  for (const p of people) nameOf.set(p.id, p.name);
  const name = (id: string | null) => (id ? (nameOf.get(id) ?? "Unknown user") : "");

  const clientName = link?.clientName ?? "Client";
  const linkStatus = (link?.status ?? null) as LinkStatus | null;
  const reconciliation = reconcile(wp.ledgerBalance, lines.map((l) => ({ kind: l.kind, description: l.description, amount: l.amount })), wp.currency);
  const openNotes = notes.filter((x) => x.status === "OPEN").length;

  return {
    workpaper: {
      ...summary(wp, clientName, linkStatus, name(wp.preparedByUserId), openNotes),
      accountId: wp.accountId,
      accountType: wp.accountType,
      currency: wp.currency,
      preparedByUserId: wp.preparedByUserId,
      snapshotTakenByName: name(wp.snapshotTakenByUserId),
      priorPeriodEnd: wp.priorPeriodEnd,
      priorLedgerBalance: wp.priorLedgerBalance ? parseAmount(wp.priorLedgerBalance).toFixed(2) : null,
      priorWorkpaperId: wp.priorWorkpaperId,
    },
    lines: lines.map((l) => ({ id: l.id, lineNumber: l.lineNumber, kind: l.kind, description: l.description, reference: l.reference ?? undefined, amount: parseAmount(l.amount).toFixed(2), isRecurring: l.isRecurring })),
    reconciliation,
    evidence: evidence.map((e) => ({ id: e.id, fileName: e.fileName, mimeType: e.mimeType, fileSize: e.fileSize, description: e.description, uploadedByName: name(e.uploadedByUserId), createdAt: e.createdAt.toISOString() })),
    adjustments: adjustments.map((a) => ({
      id: a.id,
      description: a.description,
      debitAccount: a.debitAccount,
      creditAccount: a.creditAccount,
      amount: parseAmount(a.amount).toFixed(2),
      status: a.status,
      postedReference: a.postedReference,
      createdByName: name(a.createdByUserId),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      version: n.version,
      body: n.body,
      status: n.status,
      authorName: name(n.authorUserId),
      resolvedByName: n.resolvedByUserId ? name(n.resolvedByUserId) : null,
      resolvedAt: n.resolvedAt?.toISOString() ?? null,
      resolutionComment: n.resolutionComment,
      createdAt: n.createdAt.toISOString(),
    })),
    signoffs: signoffs.map((s) => ({ id: s.id, version: s.version, step: s.step, userName: name(s.userId), practiceRole: s.practiceRole, reason: s.reason, singleStaffException: s.singleStaffException, createdAt: s.createdAt.toISOString() })),
    snapshots: snapshots.map((s) => ({ id: s.id, version: s.version, periodEnd: s.periodEnd, ledgerBalance: parseAmount(s.ledgerBalance).toFixed(2), takenAt: s.takenAt.toISOString(), takenByName: name(s.takenByUserId), takenByRole: s.takenByRole })),
    provenance: `Per the client's ledger as at ${wp.periodEnd}, pulled ${wp.snapshotTakenAt.toISOString()} by ${name(wp.snapshotTakenByUserId)} — a point-in-time snapshot, not a live figure.`,
    retentionNote:
      linkStatus && linkStatus !== "ACTIVE"
        ? `The client has ended this practice's access (${linkStatus.toLowerCase()}). This workpaper is retained by your practice as a record as of ${wp.snapshotTakenAt.toISOString().slice(0, 10)}; the balance will not refresh and no client data is read.`
        : null,
  };
}
