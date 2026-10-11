import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  approvalDecisions,
  approvalPolicies,
  approvalRequests,
  approvalSteps,
  organizationMemberships,
  organizations,
  users,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { NotificationService } from "@/domain/notifications/notification-service";
import { OrganizationArchivedError } from "@/domain/organizations/archive-rules";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import {
  ApprovalDocumentNotReadyError,
  ApprovalNotEligibleError,
  ApprovalNotPendingError,
  ApprovalPendingError,
  ApprovalPolicyNotFoundError,
  ApprovalRequestNotFoundError,
  ApprovalRequiredError,
  InvalidApprovalPolicyError,
  NoApprovalPolicyMatchesError,
} from "./errors";
import { assertReadyForRequest, loadDocument } from "./facts";
import {
  APPROVAL_DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  MAX_POLICIES_PER_ORG,
  NATIVE_APPROVE_PERMISSION,
  NATIVE_REQUEST_PERMISSION,
  describeRouting,
  policyInputSchema,
  readSteps,
  roleCanApproveType,
  selectPolicy,
  type ApprovalDocumentType,
  type DocumentFacts,
  type PolicyInput,
  type PolicyRow,
  type PolicyStep,
} from "./policy";

/**
 * The approval engine (master spec s.45): configurable, auditable multi-step approvals layered ON TOP of the existing
 * single-step flows. Read docs/security.md "Approval engine" alongside this file.
 *
 *  - No policy matches -> the engine does nothing and the document's existing behaviour is unchanged (backwards
 *    compatible by construction: the gate costs one indexed read of the organisation's active policies for that type).
 *  - A matching policy snapshots into an `approval_requests` row plus ordered `approval_steps`. The document services
 *    refuse to move the document to its approved/posted state until the latest request is APPROVED (`assertClearedIn`).
 *  - ONLY a HUMAN may decide, override or reassign - an API key, OAuth token, AI agent or automation is refused even when
 *    the role behind it is OWNER. The requester and the document's own creator/claimant can never decide it. Whether
 *    someone may decide is recomputed at DECISION time from their current active membership/role, never from creation.
 *  - Every request, decision, override and reassignment is audited with before/after and kept (resubmission = a NEW request).
 *  - No scheduler exists (owner decision), so there are no escalation timers: the inbox shows "waiting since", and an
 *    OWNER/ADMINISTRATOR (`approval:manage`) can reassign a waiting step or override with a recorded reason.
 */

export const MAX_COMMENT = 1000;
export const MIN_OVERRIDE_REASON = 5;
const LIST_LIMIT = 200;

function assertHuman(actor: Actor, permission: Parameters<typeof assertPermission>[1]): void {
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError(permission, actor.role);
}

async function assertNotArchived(tx: TenantDb, organizationId: string): Promise<{ slug: string }> {
  const [org] = await tx.select({ slug: organizations.slug, archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, organizationId));
  if (!org) throw new Error("Organization not found.");
  if (org.archivedAt) throw new OrganizationArchivedError(organizationId);
  return { slug: org.slug };
}

type RequestRow = typeof approvalRequests.$inferSelect;
type StepRow = typeof approvalSteps.$inferSelect;

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export interface PolicySnapshot {
  id: string;
  name: string;
  minAmount: string | null;
  maxAmount: string | null;
  filters: unknown;
  allowSamePersonMultipleSteps: boolean;
  steps: PolicyStep[];
}

function snapshotOf(policy: PolicyRow): PolicySnapshot {
  return {
    id: policy.id,
    name: policy.name,
    minAmount: policy.minAmount,
    maxAmount: policy.maxAmount,
    filters: policy.filters,
    allowSamePersonMultipleSteps: policy.allowSamePersonMultipleSteps,
    steps: readSteps(policy),
  };
}

/** Active, current members of the organisation with their CURRENT role. */
async function loadActiveMembers(tx: TenantDb, organizationId: string) {
  return tx
    .select({ userId: organizationMemberships.userId, role: organizationMemberships.role, name: users.name })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
}

/** Who could decide this step right now (named people or role holders who are active, hold the native permission, and are not excluded). */
async function resolveApprovers(
  tx: TenantDb,
  organizationId: string,
  type: ApprovalDocumentType,
  step: { requiredRoles: unknown; requiredUserIds: unknown },
  excluded: readonly string[],
): Promise<string[]> {
  const roles = asStringArray(step.requiredRoles);
  const named = asStringArray(step.requiredUserIds);
  const members = await loadActiveMembers(tx, organizationId);
  return members
    .filter((m) => !excluded.includes(m.userId) && roleHasPermission(m.role, NATIVE_APPROVE_PERMISSION[type]) && (named.includes(m.userId) || roles.includes(m.role)))
    .map((m) => m.userId)
    .slice(0, 50);
}

async function notify(
  tx: TenantDb,
  organizationId: string,
  slug: string,
  recipients: readonly string[],
  request: Pick<RequestRow, "id" | "documentType" | "documentLabel" | "amount" | "currency">,
  title: string,
  body: string,
  severity: "INFO" | "ACTION" = "ACTION",
): Promise<void> {
  if (recipients.length === 0) return;
  await NotificationService.createIn(tx, organizationId, recipients, {
    title,
    body,
    link: `/${slug}/approvals`,
    severity,
    source: "system",
    sourceRefId: request.id,
  });
}

function requestView(row: RequestRow) {
  return { ...row, excludedUserIds: asStringArray(row.excludedUserIds) };
}

export interface EligibilityInput {
  userId: string;
  membershipRole: MembershipRole | null;
  membershipActive: boolean;
  type: ApprovalDocumentType;
  excludedUserIds: readonly string[];
  step: { id: string; requiredRoles: unknown; requiredUserIds: unknown };
  /** This person's earlier APPROVE decisions on the request: the step ids. */
  earlierApprovalStepIds: readonly string[];
  allowSamePersonMultipleSteps: boolean;
}

/** Pure decision-time eligibility. `repeat` is true when the policy explicitly let one person satisfy a second step. */
export function evaluateEligibility(input: EligibilityInput): { ok: true; repeat: boolean } | { ok: false; reason: string } {
  if (!input.membershipActive || !input.membershipRole) return { ok: false, reason: "You are not an active member of this organization." };
  if (input.excludedUserIds.includes(input.userId)) {
    return { ok: false, reason: "You raised or created this document, so someone else must approve it." };
  }
  if (!roleHasPermission(input.membershipRole, NATIVE_APPROVE_PERMISSION[input.type])) {
    return { ok: false, reason: `Your current role does not allow approving ${DOCUMENT_TYPE_LABEL[input.type].toLowerCase()}s.` };
  }
  const named = asStringArray(input.step.requiredUserIds).includes(input.userId);
  const byRole = asStringArray(input.step.requiredRoles).includes(input.membershipRole);
  if (!named && !byRole) return { ok: false, reason: "This step is not assigned to you or to your current role." };
  if (input.earlierApprovalStepIds.includes(input.step.id)) return { ok: false, reason: "You have already approved this step." };
  const repeat = input.earlierApprovalStepIds.length > 0;
  if (repeat && !input.allowSamePersonMultipleSteps) {
    return { ok: false, reason: "You already approved an earlier step of this request, and this policy needs a different person for each step." };
  }
  return { ok: true, repeat };
}

async function loadMembership(tx: TenantDb, organizationId: string, userId: string) {
  const [row] = await tx
    .select({ role: organizationMemberships.role, isActive: organizationMemberships.isActive })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
  return row ?? null;
}

async function loadRequestForUpdate(tx: TenantDb, organizationId: string, requestId: string): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.id, requestId)))
    .for("update");
  if (!row) throw new ApprovalRequestNotFoundError(requestId);
  return row;
}

async function loadSteps(tx: TenantDb, requestId: string): Promise<StepRow[]> {
  return tx.select().from(approvalSteps).where(eq(approvalSteps.requestId, requestId)).orderBy(asc(approvalSteps.stepIndex));
}

function snapshotAllowsRepeat(request: RequestRow): boolean {
  return Boolean((request.policySnapshot as { allowSamePersonMultipleSteps?: boolean } | null)?.allowSamePersonMultipleSteps);
}

/** What the approvers saw: amount, currency, supplier(s), accounts, projects. An approval only clears a document that still has the same fingerprint. */
export function factsFingerprint(facts: DocumentFacts): string {
  const sorted = (v: string[]) => [...v].sort();
  return JSON.stringify([Number(facts.amount), facts.currency, sorted(facts.supplierContactIds), sorted(facts.accountIds), sorted(facts.projectIds)]);
}

function fingerprintMatches(request: RequestRow, facts: DocumentFacts): boolean {
  const stored = (request.policySnapshot as { factsFingerprint?: string } | null)?.factsFingerprint;
  return stored === undefined || stored === factsFingerprint(facts);
}

export type DecisionOutcome = "STEP_APPROVED" | "PENDING_MORE" | "APPROVED" | "REJECTED";

async function parsePolicyInput(input: PolicyInput) {
  const parsed = policyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidApprovalPolicyError(parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/** Every named user must be an active member whose CURRENT role can approve the type; every named role must be able to. */
async function validatePolicySteps(tx: TenantDb, organizationId: string, type: ApprovalDocumentType, steps: PolicyStep[]) {
  const members = await loadActiveMembers(tx, organizationId);
  const byId = new Map(members.map((m) => [m.userId, m]));
  for (const step of steps) {
    for (const role of step.roles) {
      if (!roleCanApproveType(role, type)) {
        throw new InvalidApprovalPolicyError(
          `Step "${step.name}": the ${role.replace(/_/g, " ").toLowerCase()} role cannot approve ${DOCUMENT_TYPE_LABEL[type].toLowerCase()}s, so no one could ever satisfy it.`,
        );
      }
    }
    for (const userId of step.userIds) {
      const member = byId.get(userId);
      if (!member) throw new InvalidApprovalPolicyError(`Step "${step.name}" names someone who is not an active member of this organization.`);
      if (!roleCanApproveType(member.role, type)) {
        throw new InvalidApprovalPolicyError(`Step "${step.name}": ${member.name} cannot currently approve ${DOCUMENT_TYPE_LABEL[type].toLowerCase()}s with their role.`);
      }
    }
  }
}

const policyAudit = (p: typeof approvalPolicies.$inferSelect) => ({
  name: p.name,
  documentType: p.documentType,
  priority: p.priority,
  isActive: p.isActive,
  minAmount: p.minAmount,
  maxAmount: p.maxAmount,
  filters: p.filters,
  steps: p.steps,
  allowSamePersonMultipleSteps: p.allowSamePersonMultipleSteps,
});

/** Opens a request for an already-loaded document inside the caller's transaction. Null when no policy matches. */
async function openRequestIn(
  tx: TenantDb,
  actor: Actor,
  type: ApprovalDocumentType,
  documentId: string,
  options: { requireReady: boolean },
): Promise<RequestRow | null> {
  const doc = await loadDocument(tx, actor.organizationId, type, documentId);
  if (!doc) throw new ApprovalDocumentNotReadyError(`${DOCUMENT_TYPE_LABEL[type]} was not found in this organization.`);
  if (options.requireReady) assertReadyForRequest(doc);

  const [existing] = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.organizationId, actor.organizationId), eq(approvalRequests.documentType, type), eq(approvalRequests.documentId, documentId), eq(approvalRequests.status, "PENDING")));
  if (existing) return existing;

  const policies = await tx
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.organizationId, actor.organizationId), eq(approvalPolicies.documentType, type), eq(approvalPolicies.isActive, true)));
  const policy = selectPolicy(policies, doc.facts);
  if (!policy) return null;

  const steps = readSteps(policy);
  if (steps.length === 0) throw new InvalidApprovalPolicyError(`Approval policy "${policy.name}" has no valid steps; fix it before requesting approval.`);

  const excluded = [...new Set([actor.userId, ...doc.excludedUserIds])];
  const now = new Date();
  const [request] = await tx
    .insert(approvalRequests)
    .values({
      organizationId: actor.organizationId,
      documentType: type,
      documentId,
      documentLabel: doc.label,
      documentSummary: doc.summary,
      amount: doc.facts.amount,
      currency: doc.facts.currency,
      policyId: policy.id,
      policyName: policy.name,
      policySnapshot: { ...snapshotOf(policy), factsFingerprint: factsFingerprint(doc.facts) },
      status: "PENDING",
      requestedById: actor.userId,
      excludedUserIds: excluded,
      requestedAt: now,
    })
    .returning();
  if (!request) throw new Error("Failed to create approval request.");

  const stepRows = await tx
    .insert(approvalSteps)
    .values(
      steps.map((s, i) => ({
        organizationId: actor.organizationId,
        requestId: request.id,
        stepIndex: i,
        name: s.name,
        requiredRoles: s.roles,
        requiredUserIds: s.userIds,
        requiredApprovals: s.requiredApprovals,
        status: "PENDING",
        openedAt: i === 0 ? now : null,
      })),
    )
    .returning();

  await AuditService.record(tx, actor, {
    action: "approval.requested",
    entityType: "ApprovalRequest",
    entityId: request.id,
    after: {
      documentType: type,
      documentId,
      documentLabel: doc.label,
      amount: doc.facts.amount,
      currency: doc.facts.currency,
      policy: policy.name,
      steps: steps.map((s) => s.name),
    },
  });

  const { slug } = await assertNotArchived(tx, actor.organizationId);
  const first = stepRows.find((s) => s.stepIndex === 0);
  if (first) {
    const approvers = await resolveApprovers(tx, actor.organizationId, type, first, excluded);
    await notify(
      tx,
      actor.organizationId,
      slug,
      approvers,
      request,
      `Approval needed: ${DOCUMENT_TYPE_LABEL[type]} ${doc.label}`,
      `${doc.summary}. Step 1: ${first.name}.`,
    );
  }
  return request;
}

/** Marks a PENDING request (if any) closed, with its remaining steps, inside the caller's tx. Returns the request or null. */
async function closeOpenRequestIn(
  tx: TenantDb,
  actor: Actor,
  type: ApprovalDocumentType,
  documentId: string,
  status: "CANCELLED" | "REJECTED",
  reason: string,
): Promise<RequestRow | null> {
  const [open] = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.organizationId, actor.organizationId), eq(approvalRequests.documentType, type), eq(approvalRequests.documentId, documentId), eq(approvalRequests.status, "PENDING")))
    .for("update");
  if (!open) return null;
  const now = new Date();
  await tx
    .update(approvalSteps)
    .set({ status: "CANCELLED", completedAt: now })
    .where(and(eq(approvalSteps.requestId, open.id), eq(approvalSteps.status, "PENDING")));
  const [updated] = await tx
    .update(approvalRequests)
    .set({ status, decidedAt: now, decisionReason: reason, updatedAt: now })
    .where(eq(approvalRequests.id, open.id))
    .returning();
  await AuditService.record(tx, actor, {
    action: status === "CANCELLED" ? "approval.cancelled" : "approval.rejected_with_document",
    entityType: "ApprovalRequest",
    entityId: open.id,
    before: { status: "PENDING" },
    after: { status, reason },
  });
  return updated ?? null;
}

export interface InboxItem {
  id: string;
  documentType: ApprovalDocumentType;
  documentId: string;
  documentLabel: string;
  documentSummary: string | null;
  amount: string;
  currency: string;
  status: string;
  policyName: string;
  requestedById: string;
  requestedByName: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
  overrideReason: string | null;
  /** The step currently waiting, with how long it has been waiting. */
  currentStep: { name: string; requiredApprovals: number; approvalsSoFar: number; openedAt: Date | null } | null;
  steps: Array<{ name: string; status: string; requiredApprovals: number }>;
}

async function toInboxItems(tx: TenantDb, rows: RequestRow[]): Promise<InboxItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const steps = await tx.select().from(approvalSteps).where(inArray(approvalSteps.requestId, ids)).orderBy(asc(approvalSteps.stepIndex));
  const approvals = await tx
    .select({ stepId: approvalDecisions.stepId })
    .from(approvalDecisions)
    .where(and(inArray(approvalDecisions.requestId, ids), eq(approvalDecisions.decision, "APPROVE")));
  const countByStep = new Map<string, number>();
  for (const a of approvals) if (a.stepId) countByStep.set(a.stepId, (countByStep.get(a.stepId) ?? 0) + 1);
  const requesterIds = [...new Set(rows.map((r) => r.requestedById))];
  const names = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, requesterIds));
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((r) => {
    const mine = steps.filter((s) => s.requestId === r.id);
    const current = r.status === "PENDING" ? mine.find((s) => s.status === "PENDING") : undefined;
    return {
      id: r.id,
      documentType: r.documentType as ApprovalDocumentType,
      documentId: r.documentId,
      documentLabel: r.documentLabel,
      documentSummary: r.documentSummary,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      policyName: r.policyName,
      requestedById: r.requestedById,
      requestedByName: nameOf.get(r.requestedById) ?? "Unknown",
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      decisionReason: r.decisionReason,
      overrideReason: r.overrideReason,
      currentStep: current
        ? { name: current.name, requiredApprovals: current.requiredApprovals, approvalsSoFar: countByStep.get(current.id) ?? 0, openedAt: current.openedAt }
        : null,
      steps: mine.map((s) => ({ name: s.name, status: s.status, requiredApprovals: s.requiredApprovals })),
    };
  });
}

export const ApprovalService = {
  // ---- Policies (approval:manage, human only) -------------------------------------------------------------------

  async listPolicies(actor: Actor) {
    assertPermission(actor, "approval:manage");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.organizationId, actor.organizationId))
        .orderBy(asc(approvalPolicies.documentType), asc(approvalPolicies.priority), asc(approvalPolicies.createdAt))
        .limit(MAX_POLICIES_PER_ORG),
    );
  },

  async createPolicy(actor: Actor, input: PolicyInput) {
    assertPermission(actor, "approval:manage");
    assertHuman(actor, "approval:manage");
    const data = await parsePolicyInput(input);
    return withTenant(actor.organizationId, async (tx) => {
      await assertNotArchived(tx, actor.organizationId);
      const existing = await tx.select({ id: approvalPolicies.id }).from(approvalPolicies).where(eq(approvalPolicies.organizationId, actor.organizationId)).limit(MAX_POLICIES_PER_ORG);
      if (existing.length >= MAX_POLICIES_PER_ORG) throw new InvalidApprovalPolicyError(`An organization can have at most ${MAX_POLICIES_PER_ORG} approval policies.`);
      await validatePolicySteps(tx, actor.organizationId, data.documentType, data.steps);
      const [row] = await tx
        .insert(approvalPolicies)
        .values({
          organizationId: actor.organizationId,
          name: data.name,
          documentType: data.documentType,
          priority: data.priority,
          isActive: data.isActive,
          minAmount: data.minAmount,
          maxAmount: data.maxAmount,
          filters: data.filters,
          steps: data.steps,
          allowSamePersonMultipleSteps: data.allowSamePersonMultipleSteps,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create approval policy.");
      await AuditService.record(tx, actor, { action: "approval_policy.created", entityType: "ApprovalPolicy", entityId: row.id, after: policyAudit(row) });
      return row;
    });
  },

  async updatePolicy(actor: Actor, policyId: string, input: PolicyInput) {
    assertPermission(actor, "approval:manage");
    assertHuman(actor, "approval:manage");
    const data = await parsePolicyInput(input);
    return withTenant(actor.organizationId, async (tx) => {
      await assertNotArchived(tx, actor.organizationId);
      const [before] = await tx.select().from(approvalPolicies).where(and(eq(approvalPolicies.organizationId, actor.organizationId), eq(approvalPolicies.id, policyId))).for("update");
      if (!before) throw new ApprovalPolicyNotFoundError(policyId);
      await validatePolicySteps(tx, actor.organizationId, data.documentType, data.steps);
      const [row] = await tx
        .update(approvalPolicies)
        .set({
          name: data.name,
          documentType: data.documentType,
          priority: data.priority,
          isActive: data.isActive,
          minAmount: data.minAmount,
          maxAmount: data.maxAmount,
          filters: data.filters,
          steps: data.steps,
          allowSamePersonMultipleSteps: data.allowSamePersonMultipleSteps,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(approvalPolicies.id, policyId))
        .returning();
      await AuditService.record(tx, actor, { action: "approval_policy.updated", entityType: "ApprovalPolicy", entityId: policyId, before: policyAudit(before), after: row ? policyAudit(row) : null });
      return row!;
    });
  },

  /** Deactivating a policy never changes an in-flight request (it snapshots its policy); new submissions simply stop matching it. */
  async setPolicyActive(actor: Actor, policyId: string, isActive: boolean) {
    assertPermission(actor, "approval:manage");
    assertHuman(actor, "approval:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await assertNotArchived(tx, actor.organizationId);
      const [before] = await tx.select().from(approvalPolicies).where(and(eq(approvalPolicies.organizationId, actor.organizationId), eq(approvalPolicies.id, policyId))).for("update");
      if (!before) throw new ApprovalPolicyNotFoundError(policyId);
      const [row] = await tx.update(approvalPolicies).set({ isActive, updatedById: actor.userId, updatedAt: new Date() }).where(eq(approvalPolicies.id, policyId)).returning();
      await AuditService.record(tx, actor, {
        action: isActive ? "approval_policy.activated" : "approval_policy.deactivated",
        entityType: "ApprovalPolicy",
        entityId: policyId,
        before: { isActive: before.isActive },
        after: { isActive },
      });
      return row!;
    });
  },

  /** "How would this amount route?" in plain English, without creating anything. */
  async previewRouting(actor: Actor, input: { documentType: ApprovalDocumentType; amount: string; currency: string; supplierContactId?: string | null; accountId?: string | null; projectId?: string | null; raisedByUserId?: string | null }) {
    assertPermission(actor, "approval:manage");
    if (!APPROVAL_DOCUMENT_TYPES.includes(input.documentType)) throw new InvalidApprovalPolicyError("Unknown document type.");
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(input.amount.trim())) throw new InvalidApprovalPolicyError("Enter the amount as a plain number, for example 2500.00.");
    return withTenant(actor.organizationId, async (tx) => {
      const policies = await tx
        .select()
        .from(approvalPolicies)
        .where(and(eq(approvalPolicies.organizationId, actor.organizationId), eq(approvalPolicies.documentType, input.documentType), eq(approvalPolicies.isActive, true)));
      const members = await loadActiveMembers(tx, actor.organizationId);
      const facts: DocumentFacts = {
        documentType: input.documentType,
        amount: input.amount.trim(),
        currency: input.currency.trim().toUpperCase(),
        supplierContactIds: input.supplierContactId ? [input.supplierContactId] : [],
        accountIds: input.accountId ? [input.accountId] : [],
        projectIds: input.projectId ? [input.projectId] : [],
        raisedByUserId: input.raisedByUserId ?? null,
      };
      return describeRouting(policies, facts, new Map(members.map((m) => [m.userId, m.name])));
    });
  },

  // ---- Opening requests -----------------------------------------------------------------------------------------

  /**
   * Called by a document service INSIDE its own submit transaction (expense claim submit, payment run submit for
   * approval): opens a request if a policy matches, otherwise returns null and the document proceeds exactly as before.
   */
  async openForSubmissionIn(tx: TenantDb, actor: Actor, type: ApprovalDocumentType, documentId: string): Promise<RequestRow | null> {
    const policies = await tx
      .select({ id: approvalPolicies.id })
      .from(approvalPolicies)
      .where(and(eq(approvalPolicies.organizationId, actor.organizationId), eq(approvalPolicies.documentType, type), eq(approvalPolicies.isActive, true)))
      .limit(1);
    if (policies.length === 0) return null;
    return openRequestIn(tx, actor, type, documentId, { requireReady: false });
  },

  /** Explicit "request approval" for documents with no submit step of their own (a draft supplier bill). Throws when no policy applies. */
  async requestApproval(actor: Actor, type: ApprovalDocumentType, documentId: string) {
    assertPermission(actor, NATIVE_REQUEST_PERMISSION[type]);
    return withTenant(actor.organizationId, async (tx) => {
      await assertNotArchived(tx, actor.organizationId);
      const request = await openRequestIn(tx, actor, type, documentId, { requireReady: true });
      if (!request) {
        const doc = await loadDocument(tx, actor.organizationId, type, documentId);
        throw new NoApprovalPolicyMatchesError(type, doc?.label ?? documentId);
      }
      return requestView(request);
    });
  },

  // ---- The gate (called by the document services) ----------------------------------------------------------------

  /**
   * Throws unless the document is clear to move to its approved/posted state: either no active policy governs it, or its
   * latest request is APPROVED for the same amount. A PENDING request, a REJECTED/CANCELLED one, or an APPROVED one whose
   * amount no longer matches blocks it while a policy still applies. One indexed read when the org has no policy of that type.
   */
  async assertClearedIn(tx: TenantDb, organizationId: string, type: ApprovalDocumentType, documentId: string): Promise<void> {
    const active = await tx
      .select({ id: approvalPolicies.id })
      .from(approvalPolicies)
      .where(and(eq(approvalPolicies.organizationId, organizationId), eq(approvalPolicies.documentType, type), eq(approvalPolicies.isActive, true)))
      .limit(1);
    const [latest] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.documentType, type), eq(approvalRequests.documentId, documentId)))
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(1);
    if (latest?.status === "PENDING") throw new ApprovalPendingError(type, latest.documentLabel);
    if (active.length === 0 && !latest) return;

    const doc = await loadDocument(tx, organizationId, type, documentId);
    if (!doc) return;
    if (latest?.status === "APPROVED" && latest.currency === doc.facts.currency && Number(latest.amount) === Number(doc.facts.amount) && fingerprintMatches(latest, doc.facts)) return;
    if (active.length === 0) return;
    const policies = await tx
      .select()
      .from(approvalPolicies)
      .where(and(eq(approvalPolicies.organizationId, organizationId), eq(approvalPolicies.documentType, type), eq(approvalPolicies.isActive, true)));
    if (selectPolicy(policies, doc.facts)) throw new ApprovalRequiredError(type, doc.label);
  },

  /** A document edited, deleted or cancelled while waiting: closes its open request (audited). No-op when none is open. */
  async cancelOpenIn(tx: TenantDb, actor: Actor, type: ApprovalDocumentType, documentId: string, reason: string): Promise<void> {
    await closeOpenRequestIn(tx, actor, type, documentId, "CANCELLED", reason);
  },

  /** The document's own reject action (e.g. an expense claim) while a request is open: closes it as REJECTED with the reason. */
  async rejectOpenIn(tx: TenantDb, actor: Actor, type: ApprovalDocumentType, documentId: string, reason: string): Promise<void> {
    await closeOpenRequestIn(tx, actor, type, documentId, "REJECTED", reason);
  },

  // ---- Deciding --------------------------------------------------------------------------------------------------

  /** Approve or reject the current step. HUMAN only; eligibility is recomputed from the decider's CURRENT active membership. */
  async decide(actor: Actor, requestId: string, input: { decision: "APPROVE" | "REJECT"; comment?: string | null }) {
    assertHuman(actor, "approval:manage");
    const comment = (input.comment ?? "").trim();
    if (comment.length > MAX_COMMENT) throw new ApprovalNotEligibleError(`Comments can be at most ${MAX_COMMENT} characters.`);
    if (input.decision === "REJECT" && comment.length === 0) throw new ApprovalNotEligibleError("Please give a reason when rejecting.");
    return withTenant(actor.organizationId, async (tx) => {
      const { slug } = await assertNotArchived(tx, actor.organizationId);
      const request = await loadRequestForUpdate(tx, actor.organizationId, requestId);
      if (request.status !== "PENDING") throw new ApprovalNotPendingError();
      const type = request.documentType as ApprovalDocumentType;
      const steps = await loadSteps(tx, request.id);
      const step = steps.find((s) => s.status === "PENDING");
      if (!step) throw new ApprovalNotPendingError();

      const membership = await loadMembership(tx, actor.organizationId, actor.userId);
      const earlier = await tx
        .select({ stepId: approvalDecisions.stepId })
        .from(approvalDecisions)
        .where(and(eq(approvalDecisions.requestId, request.id), eq(approvalDecisions.decidedById, actor.userId), eq(approvalDecisions.decision, "APPROVE")));
      const verdict = evaluateEligibility({
        userId: actor.userId,
        membershipRole: membership?.role ?? null,
        membershipActive: membership?.isActive ?? false,
        type,
        excludedUserIds: asStringArray(request.excludedUserIds),
        step,
        earlierApprovalStepIds: earlier.map((e) => e.stepId).filter((s): s is string => !!s),
        allowSamePersonMultipleSteps: snapshotAllowsRepeat(request),
      });
      if (!verdict.ok) throw new ApprovalNotEligibleError(verdict.reason);
      const deciderRole = membership!.role;
      const now = new Date();

      await tx.insert(approvalDecisions).values({
        organizationId: actor.organizationId,
        requestId: request.id,
        stepId: step.id,
        decidedById: actor.userId,
        decision: input.decision,
        comment: comment || null,
        deciderRole,
        repeatApprover: verdict.repeat,
      });

      if (input.decision === "REJECT") {
        await tx.update(approvalSteps).set({ status: "REJECTED", completedAt: now }).where(eq(approvalSteps.id, step.id));
        await tx
          .update(approvalSteps)
          .set({ status: "CANCELLED", completedAt: now })
          .where(and(eq(approvalSteps.requestId, request.id), eq(approvalSteps.status, "PENDING")));
        const [updated] = await tx
          .update(approvalRequests)
          .set({ status: "REJECTED", decidedAt: now, decisionReason: comment, updatedAt: now })
          .where(eq(approvalRequests.id, request.id))
          .returning();
        await AuditService.record(tx, actor, {
          action: "approval.rejected",
          entityType: "ApprovalRequest",
          entityId: request.id,
          before: { status: "PENDING", step: step.name },
          after: { status: "REJECTED", step: step.name, reason: comment, deciderRole },
        });
        await notify(tx, actor.organizationId, slug, [request.requestedById], request, `Rejected: ${DOCUMENT_TYPE_LABEL[type]} ${request.documentLabel}`, comment, "INFO");
        return { request: requestView(updated!), outcome: "REJECTED" as DecisionOutcome, repeatApprover: verdict.repeat };
      }

      const count = (await tx.select({ id: approvalDecisions.id }).from(approvalDecisions).where(and(eq(approvalDecisions.stepId, step.id), eq(approvalDecisions.decision, "APPROVE")))).length;
      if (count < step.requiredApprovals) {
        await AuditService.record(tx, actor, {
          action: "approval.step_progress",
          entityType: "ApprovalRequest",
          entityId: request.id,
          before: { step: step.name, approvals: count - 1 },
          after: { step: step.name, approvals: count, of: step.requiredApprovals, repeatApprover: verdict.repeat, deciderRole },
        });
        return { request: requestView(request), outcome: "PENDING_MORE" as DecisionOutcome, repeatApprover: verdict.repeat };
      }

      await tx.update(approvalSteps).set({ status: "APPROVED", completedAt: now }).where(eq(approvalSteps.id, step.id));
      const next = steps.find((s) => s.stepIndex > step.stepIndex && s.status === "PENDING");
      if (next) {
        await tx.update(approvalSteps).set({ openedAt: now }).where(eq(approvalSteps.id, next.id));
        await AuditService.record(tx, actor, {
          action: "approval.step_approved",
          entityType: "ApprovalRequest",
          entityId: request.id,
          before: { step: step.name, status: "PENDING" },
          after: { step: step.name, status: "APPROVED", nextStep: next.name, repeatApprover: verdict.repeat, deciderRole },
        });
        const approvers = await resolveApprovers(tx, actor.organizationId, type, next, asStringArray(request.excludedUserIds));
        await notify(tx, actor.organizationId, slug, approvers, request, `Approval needed: ${DOCUMENT_TYPE_LABEL[type]} ${request.documentLabel}`, `${request.documentSummary ?? ""}. Step ${next.stepIndex + 1}: ${next.name}.`);
        return { request: requestView(request), outcome: "STEP_APPROVED" as DecisionOutcome, repeatApprover: verdict.repeat };
      }

      const [updated] = await tx.update(approvalRequests).set({ status: "APPROVED", decidedAt: now, updatedAt: now }).where(eq(approvalRequests.id, request.id)).returning();
      await AuditService.record(tx, actor, {
        action: "approval.approved",
        entityType: "ApprovalRequest",
        entityId: request.id,
        before: { status: "PENDING" },
        after: { status: "APPROVED", finalStep: step.name, repeatApprover: verdict.repeat, deciderRole },
      });
      await notify(tx, actor.organizationId, slug, [request.requestedById], request, `Approved: ${DOCUMENT_TYPE_LABEL[type]} ${request.documentLabel}`, "All approval steps are complete.", "INFO");
      return { request: requestView(updated!), outcome: "APPROVED" as DecisionOutcome, repeatApprover: verdict.repeat };
    });
  },

  /**
   * OWNER/ADMINISTRATOR forces the outcome of a pending request WITH a reason. Human only, never by the person who raised
   * the document, always audited, remaining steps are SKIPPED (never silently ignored).
   */
  async override(actor: Actor, requestId: string, input: { outcome: "APPROVE" | "REJECT"; reason: string }) {
    assertPermission(actor, "approval:manage");
    assertHuman(actor, "approval:manage");
    const reason = input.reason.trim();
    if (reason.length < MIN_OVERRIDE_REASON) throw new ApprovalNotEligibleError(`Give a reason of at least ${MIN_OVERRIDE_REASON} characters to override an approval.`);
    if (reason.length > MAX_COMMENT) throw new ApprovalNotEligibleError(`Reasons can be at most ${MAX_COMMENT} characters.`);
    return withTenant(actor.organizationId, async (tx) => {
      const { slug } = await assertNotArchived(tx, actor.organizationId);
      const request = await loadRequestForUpdate(tx, actor.organizationId, requestId);
      if (request.status !== "PENDING") throw new ApprovalNotPendingError();
      if (asStringArray(request.excludedUserIds).includes(actor.userId)) {
        throw new ApprovalNotEligibleError("You raised or created this document, so you cannot override its approval.");
      }
      const membership = await loadMembership(tx, actor.organizationId, actor.userId);
      if (!membership?.isActive || !roleHasPermission(membership.role, "approval:manage")) {
        throw new ApprovalNotEligibleError("Your current role cannot override approvals.");
      }
      const type = request.documentType as ApprovalDocumentType;
      if (input.outcome === "APPROVE" && !roleHasPermission(membership.role, NATIVE_APPROVE_PERMISSION[type])) {
        throw new ApprovalNotEligibleError(`Your current role does not allow approving ${DOCUMENT_TYPE_LABEL[type].toLowerCase()}s.`);
      }
      const steps = await loadSteps(tx, request.id);
      const open = steps.find((s) => s.status === "PENDING");
      const now = new Date();
      const approve = input.outcome === "APPROVE";
      await tx.update(approvalSteps).set({ status: approve ? "SKIPPED" : "CANCELLED", completedAt: now }).where(and(eq(approvalSteps.requestId, request.id), eq(approvalSteps.status, "PENDING")));
      await tx.insert(approvalDecisions).values({
        organizationId: actor.organizationId,
        requestId: request.id,
        stepId: open?.id ?? null,
        decidedById: actor.userId,
        decision: approve ? "OVERRIDE_APPROVE" : "OVERRIDE_REJECT",
        comment: reason,
        deciderRole: membership.role,
        repeatApprover: false,
      });
      const [updated] = await tx
        .update(approvalRequests)
        .set({ status: approve ? "APPROVED" : "REJECTED", decidedAt: now, decisionReason: reason, overriddenById: actor.userId, overrideReason: reason, updatedAt: now })
        .where(eq(approvalRequests.id, request.id))
        .returning();
      await AuditService.record(tx, actor, {
        action: approve ? "approval.override_approved" : "approval.override_rejected",
        entityType: "ApprovalRequest",
        entityId: request.id,
        before: { status: "PENDING", waitingStep: open?.name ?? null, skippedSteps: steps.filter((s) => s.status === "PENDING").map((s) => s.name) },
        after: { status: approve ? "APPROVED" : "REJECTED", reason, overriddenBy: actor.userId },
      });
      await notify(
        tx,
        actor.organizationId,
        slug,
        [request.requestedById],
        request,
        `${approve ? "Approved (override)" : "Rejected (override)"}: ${DOCUMENT_TYPE_LABEL[type]} ${request.documentLabel}`,
        reason,
        "INFO",
      );
      return { request: requestView(updated!), outcome: (approve ? "APPROVED" : "REJECTED") as DecisionOutcome, repeatApprover: false };
    });
  },

  /** OWNER/ADMINISTRATOR reassigns the waiting step to specific people (replacing its roles/people), with a reason. Audited; notifies the new approvers. */
  async reassign(actor: Actor, requestId: string, input: { userIds: string[]; reason: string }) {
    assertPermission(actor, "approval:manage");
    assertHuman(actor, "approval:manage");
    const reason = input.reason.trim();
    if (reason.length < MIN_OVERRIDE_REASON) throw new ApprovalNotEligibleError(`Give a reason of at least ${MIN_OVERRIDE_REASON} characters to reassign an approval.`);
    if (input.userIds.length === 0) throw new ApprovalNotEligibleError("Choose at least one person to reassign the step to.");
    return withTenant(actor.organizationId, async (tx) => {
      const { slug } = await assertNotArchived(tx, actor.organizationId);
      const request = await loadRequestForUpdate(tx, actor.organizationId, requestId);
      if (request.status !== "PENDING") throw new ApprovalNotPendingError();
      const type = request.documentType as ApprovalDocumentType;
      const excluded = asStringArray(request.excludedUserIds);
      const members = await loadActiveMembers(tx, actor.organizationId);
      const byId = new Map(members.map((m) => [m.userId, m]));
      for (const userId of new Set(input.userIds)) {
        const member = byId.get(userId);
        if (!member) throw new ApprovalNotEligibleError("Choose people who are active members of this organization.");
        if (excluded.includes(userId)) throw new ApprovalNotEligibleError(`${member.name} raised or created this document and cannot approve it.`);
        if (!roleHasPermission(member.role, NATIVE_APPROVE_PERMISSION[type])) {
          throw new ApprovalNotEligibleError(`${member.name} cannot currently approve ${DOCUMENT_TYPE_LABEL[type].toLowerCase()}s with their role.`);
        }
      }
      const steps = await loadSteps(tx, request.id);
      const step = steps.find((s) => s.status === "PENDING");
      if (!step) throw new ApprovalNotPendingError();
      const newUsers = [...new Set(input.userIds)];
      await tx.update(approvalSteps).set({ requiredRoles: [], requiredUserIds: newUsers }).where(eq(approvalSteps.id, step.id));
      await tx.insert(approvalDecisions).values({
        organizationId: actor.organizationId,
        requestId: request.id,
        stepId: step.id,
        decidedById: actor.userId,
        decision: "REASSIGN",
        comment: reason,
        deciderRole: byId.get(actor.userId)?.role ?? actor.role,
        repeatApprover: false,
      });
      await AuditService.record(tx, actor, {
        action: "approval.reassigned",
        entityType: "ApprovalRequest",
        entityId: request.id,
        before: { step: step.name, roles: step.requiredRoles, userIds: step.requiredUserIds },
        after: { step: step.name, roles: [], userIds: newUsers, reason },
      });
      await notify(tx, actor.organizationId, slug, newUsers, request, `Approval needed: ${DOCUMENT_TYPE_LABEL[type]} ${request.documentLabel}`, `${request.documentSummary ?? ""}. Reassigned to you: ${step.name}.`);
      return requestView(request);
    });
  },

  // ---- Reading ---------------------------------------------------------------------------------------------------

  /**
   * The signed-in person's approvals. `waitingForMe` is computed from CURRENT roles: pending requests whose open step names
   * them (or their role), that they did not raise, and have not already approved. `mine` = requests they raised.
   * `all` is only filled for approval:manage. Bounded; no per-row queries.
   */
  async inbox(actor: Actor) {
    assertHuman(actor, "approval:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const membership = await loadMembership(tx, actor.organizationId, actor.userId);
      const pending = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.organizationId, actor.organizationId), eq(approvalRequests.status, "PENDING")))
        .orderBy(asc(approvalRequests.requestedAt))
        .limit(LIST_LIMIT);
      const openSteps = pending.length
        ? await tx.select().from(approvalSteps).where(and(inArray(approvalSteps.requestId, pending.map((p) => p.id)), eq(approvalSteps.status, "PENDING"))).orderBy(asc(approvalSteps.stepIndex))
        : [];
      const mineApprovals = pending.length
        ? await tx
            .select({ requestId: approvalDecisions.requestId, stepId: approvalDecisions.stepId })
            .from(approvalDecisions)
            .where(and(inArray(approvalDecisions.requestId, pending.map((p) => p.id)), eq(approvalDecisions.decidedById, actor.userId), eq(approvalDecisions.decision, "APPROVE")))
        : [];
      const waitingIds = pending
        .filter((request) => {
          const step = openSteps.find((s) => s.requestId === request.id);
          if (!step) return false;
          const earlier = mineApprovals.filter((a) => a.requestId === request.id).map((a) => a.stepId).filter((s): s is string => !!s);
          return evaluateEligibility({
            userId: actor.userId,
            membershipRole: membership?.role ?? null,
            membershipActive: membership?.isActive ?? false,
            type: request.documentType as ApprovalDocumentType,
            excludedUserIds: asStringArray(request.excludedUserIds),
            step,
            earlierApprovalStepIds: earlier,
            allowSamePersonMultipleSteps: snapshotAllowsRepeat(request),
          }).ok;
        })
        .map((r) => r.id);
      const mineRows = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.organizationId, actor.organizationId), eq(approvalRequests.requestedById, actor.userId)))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(LIST_LIMIT);
      const isAdmin = membership?.isActive === true && roleHasPermission(membership.role, "approval:manage");
      const allRows = isAdmin
        ? await tx.select().from(approvalRequests).where(eq(approvalRequests.organizationId, actor.organizationId)).orderBy(desc(approvalRequests.requestedAt)).limit(LIST_LIMIT)
        : [];
      const needed = new Map<string, RequestRow>();
      for (const r of [...pending.filter((p) => waitingIds.includes(p.id)), ...mineRows, ...allRows]) needed.set(r.id, r);
      const items = new Map((await toInboxItems(tx, [...needed.values()])).map((i) => [i.id, i]));
      const pick = (rows: RequestRow[]) => rows.map((r) => items.get(r.id)!).filter(Boolean);
      return {
        waitingForMe: pick(pending.filter((p) => waitingIds.includes(p.id))),
        iRequested: pick(mineRows),
        all: pick(allRows),
        canSeeAll: isAdmin,
        pendingCount: waitingIds.length,
      };
    });
  },

  /** One request with its steps and decision log, for people allowed to see it (raised it, can decide a step, decided, or approval:manage). */
  async getDetail(actor: Actor, requestId: string) {
    assertHuman(actor, "approval:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [request] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.organizationId, actor.organizationId), eq(approvalRequests.id, requestId)));
      if (!request) throw new ApprovalRequestNotFoundError(requestId);
      const membership = await loadMembership(tx, actor.organizationId, actor.userId);
      const steps = await loadSteps(tx, request.id);
      const decisions = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, request.id)).orderBy(asc(approvalDecisions.createdAt));
      const type = request.documentType as ApprovalDocumentType;
      const involved =
        request.requestedById === actor.userId ||
        decisions.some((d) => d.decidedById === actor.userId) ||
        (membership?.isActive === true &&
          (roleHasPermission(membership.role, "approval:manage") ||
            steps.some((s) => asStringArray(s.requiredUserIds).includes(actor.userId) || (roleHasPermission(membership.role, NATIVE_APPROVE_PERMISSION[type]) && asStringArray(s.requiredRoles).includes(membership.role)))));
      if (!involved) throw new ApprovalRequestNotFoundError(requestId);
      const names = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set([request.requestedById, ...decisions.map((d) => d.decidedById)])]));
      const nameOf = new Map(names.map((n) => [n.id, n.name]));
      return {
        request: requestView(request),
        steps,
        decisions: decisions.map((d) => ({ ...d, decidedByName: nameOf.get(d.decidedById) ?? "Unknown" })),
        requestedByName: nameOf.get(request.requestedById) ?? "Unknown",
      };
    });
  },

  /** The approval history of one document (newest first), for the document page. Visible to anyone who can already read the document, so no extra permission. */
  async historyForDocument(tx: TenantDb, organizationId: string, type: ApprovalDocumentType, documentId: string) {
    const rows = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.documentType, type), eq(approvalRequests.documentId, documentId)))
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(20);
    return toInboxItems(tx, rows);
  },

  /** Active members who could be named in a step or a reassignment (name + current role), for the settings UI. */
  async listMembers(actor: Actor) {
    assertPermission(actor, "approval:manage");
    return withTenant(actor.organizationId, (tx) => loadActiveMembers(tx, actor.organizationId));
  },
};
