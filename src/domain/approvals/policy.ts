import { z } from "zod";
import { Money } from "@/domain/money/money";
import { membershipRoleEnum } from "@/db/schema";
import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";

/**
 * Pure policy model of the approval engine (master spec s.45): the document types it can govern, the policy / step
 * shapes, the first-match-wins selection, and the plain-English routing preview. No database access in this file, so
 * every rule here is unit-testable with hand-written numbers.
 */

export const APPROVAL_DOCUMENT_TYPES = ["SUPPLIER_BILL", "EXPENSE_CLAIM", "PAYMENT_RUN"] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABEL: Record<ApprovalDocumentType, string> = {
  SUPPLIER_BILL: "Supplier bill",
  EXPENSE_CLAIM: "Expense claim",
  PAYMENT_RUN: "Payment run",
};

/**
 * The document service's own permission for the step the engine gates. An approver must hold it NOW (recomputed at
 * decision time) in addition to being named by the policy, so a policy can only ever narrow who may approve, never
 * hand the power to someone the document's own flow would refuse. Also the permission that lets someone request approval.
 */
export const NATIVE_APPROVE_PERMISSION: Record<ApprovalDocumentType, Permission> = {
  SUPPLIER_BILL: "supplier_bill:post",
  EXPENSE_CLAIM: "expense_claim:approve",
  PAYMENT_RUN: "payment_run:approve",
};

/**
 * What the FINAL approver must also be able to do, because finishing the document (posting its journal, recording the
 * payments) is done AS the final approver through the document's own service, which checks these itself. A policy whose
 * last step could not satisfy them is refused when it is saved, rather than discovered at the worst moment.
 */
export const COMPLETION_PERMISSIONS: Record<ApprovalDocumentType, Permission[]> = {
  SUPPLIER_BILL: ["journal:post"],
  EXPENSE_CLAIM: ["journal:post"],
  PAYMENT_RUN: ["journal:post", "supplier_payment:manage"],
};

export const NATIVE_REQUEST_PERMISSION: Record<ApprovalDocumentType, Permission> = {
  SUPPLIER_BILL: "supplier_bill:manage",
  EXPENSE_CLAIM: "expense_claim:manage",
  PAYMENT_RUN: "payment_run:manage",
};

export const DOCUMENT_ROUTE: Record<ApprovalDocumentType, (orgSlug: string, id: string) => string> = {
  SUPPLIER_BILL: (slug, id) => `/${slug}/purchases/bills/${id}`,
  EXPENSE_CLAIM: (slug, id) => `/${slug}/expenses/${id}`,
  PAYMENT_RUN: (slug, id) => `/${slug}/purchases/payment-runs/${id}`,
};

export const MAX_STEPS = 6;
export const MAX_POLICIES_PER_ORG = 100;

const uuid = z.string().uuid();
const roleSchema = z.enum(membershipRoleEnum.enumValues as [MembershipRole, ...MembershipRole[]]);
const decimalString = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "Amounts must be non-negative decimals with at most 4 decimal places.");

export const stepSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    roles: z.array(roleSchema).max(10).default([]),
    userIds: z.array(uuid).max(20).default([]),
    requiredApprovals: z.number().int().min(1).max(10).default(1),
  })
  .refine((s) => s.roles.length + s.userIds.length > 0, { message: "Each step needs at least one role or one named person." });

export const filtersSchema = z
  .object({
    supplierContactIds: z.array(uuid).max(50).optional(),
    accountIds: z.array(uuid).max(50).optional(),
    projectIds: z.array(uuid).max(50).optional(),
    /** The person who raised it: the claimant for an expense claim, the submitter for a bill/payment run. */
    userIds: z.array(uuid).max(50).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
  })
  .strict();

export const policyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    documentType: z.enum(APPROVAL_DOCUMENT_TYPES),
    priority: z.number().int().min(1).max(10_000).default(100),
    isActive: z.boolean().default(true),
    minAmount: decimalString.nullable().default(null),
    maxAmount: decimalString.nullable().default(null),
    filters: filtersSchema.default({}),
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
    allowSamePersonMultipleSteps: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.minAmount !== null && p.maxAmount !== null && Number(p.maxAmount) <= Number(p.minAmount)) {
      ctx.addIssue({ code: "custom", path: ["maxAmount"], message: "The upper amount must be greater than the lower amount." });
    }
  });

export type PolicyInput = z.input<typeof policyInputSchema>;
export type ParsedPolicyInput = z.output<typeof policyInputSchema>;
export type PolicyStep = z.output<typeof stepSchema>;
export type PolicyFilters = z.output<typeof filtersSchema>;

/** What a policy needs to know about a document. Multi-valued facts match when ANY value is in the filter's list. */
export interface DocumentFacts {
  documentType: ApprovalDocumentType;
  amount: string;
  currency: string;
  supplierContactIds: string[];
  accountIds: string[];
  projectIds: string[];
  /** Who raised it (claimant / submitter). */
  raisedByUserId: string | null;
}

export interface PolicyRow {
  id: string;
  name: string;
  documentType: string;
  priority: number;
  isActive: boolean;
  minAmount: string | null;
  maxAmount: string | null;
  filters: unknown;
  steps: unknown;
  allowSamePersonMultipleSteps: boolean;
  createdAt: Date;
}

const anyIn = (wanted: readonly string[] | undefined, have: readonly string[]): boolean =>
  wanted === undefined || wanted.length === 0 || have.some((h) => wanted.includes(h));

/** Does this policy's amount band and filters match the document? Band is [min, max): min inclusive, max exclusive. */
export function policyMatches(policy: PolicyRow, facts: DocumentFacts): boolean {
  if (!policy.isActive || policy.documentType !== facts.documentType) return false;
  const amount = Money.of(facts.amount, facts.currency);
  if (policy.minAmount !== null && amount.compareTo(Money.of(policy.minAmount, facts.currency)) < 0) return false;
  if (policy.maxAmount !== null && amount.compareTo(Money.of(policy.maxAmount, facts.currency)) >= 0) return false;
  const filters = (policy.filters ?? {}) as PolicyFilters;
  if (filters.currency && filters.currency !== facts.currency) return false;
  if (!anyIn(filters.supplierContactIds, facts.supplierContactIds)) return false;
  if (!anyIn(filters.accountIds, facts.accountIds)) return false;
  if (!anyIn(filters.projectIds, facts.projectIds)) return false;
  if (filters.userIds && filters.userIds.length > 0 && (!facts.raisedByUserId || !filters.userIds.includes(facts.raisedByUserId))) return false;
  return true;
}

/** First match wins: lowest priority number, then the oldest policy. No match returns null (the document's existing flow applies unchanged). */
export function selectPolicy<T extends PolicyRow>(policies: readonly T[], facts: DocumentFacts): T | null {
  const ordered = [...policies].sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return ordered.find((p) => policyMatches(p, facts)) ?? null;
}

/** A policy's steps as stored (re-validated defensively; a corrupt row yields no steps rather than a crash). */
export function readSteps(policy: Pick<PolicyRow, "steps">): PolicyStep[] {
  const parsed = z.array(stepSchema).safeParse(policy.steps);
  return parsed.success ? parsed.data : [];
}

const ROLE_LABEL: Record<MembershipRole, string> = {
  OWNER: "an Owner",
  ADMINISTRATOR: "an Administrator",
  ACCOUNTANT: "an Accountant",
  BOOKKEEPER: "a Bookkeeper",
  ACCOUNTS_RECEIVABLE: "an Accounts Receivable officer",
  ACCOUNTS_PAYABLE: "an Accounts Payable officer",
  PAYROLL_MANAGER: "a Payroll Manager",
  MANAGER: "a Manager",
  EMPLOYEE: "an Employee",
  READ_ONLY: "a Read-only member",
};

export function describeStep(step: PolicyStep, userNames: ReadonlyMap<string, string> = new Map()): string {
  const people = step.userIds.map((id) => userNames.get(id) ?? "a named person");
  const roles = step.roles.map((r) => ROLE_LABEL[r] ?? r);
  const who = [...people, ...roles].join(" or ");
  const count = step.requiredApprovals > 1 ? `${step.requiredApprovals} approvals from ${who}` : `approval from ${who}`;
  return `${step.name}: ${count}`;
}

export function describeBand(policy: Pick<PolicyRow, "minAmount" | "maxAmount">, currency = "AUD"): string {
  const fmt = (v: string) => `${currency} ${Money.of(v, currency).toString()}`;
  if (policy.minAmount !== null && policy.maxAmount !== null) return `from ${fmt(policy.minAmount)} up to (not including) ${fmt(policy.maxAmount)}`;
  if (policy.minAmount !== null) return `of ${fmt(policy.minAmount)} or more`;
  if (policy.maxAmount !== null) return `under ${fmt(policy.maxAmount)}`;
  return "of any amount";
}

/** Plain-English description of how a given amount would be routed, for the policy preview. Pure. */
export function describeRouting(
  policies: readonly PolicyRow[],
  facts: DocumentFacts,
  userNames: ReadonlyMap<string, string> = new Map(),
): { matched: PolicyRow | null; text: string; steps: string[] } {
  const label = DOCUMENT_TYPE_LABEL[facts.documentType].toLowerCase();
  const matched = selectPolicy(policies, facts);
  const amountText = `${facts.currency} ${Money.of(facts.amount, facts.currency).toString()}`;
  if (!matched) {
    return {
      matched: null,
      steps: [],
      text: `A ${label} of ${amountText} matches no approval policy, so it follows the normal flow with no extra approval steps.`,
    };
  }
  const steps = readSteps(matched).map((s) => describeStep(s, userNames));
  const sequence = steps.map((s, i) => `${i + 1}. ${s}`).join("; then ");
  return {
    matched,
    steps,
    text: `A ${label} of ${amountText} matches "${matched.name}" and needs, in order: ${sequence}. The person who raised it can never approve it${matched.allowSamePersonMultipleSteps ? "; one person may satisfy more than one step (audited)" : ", and nobody can satisfy two steps"}.`,
  };
}

/** Whether `role` could ever satisfy a step of this document type (policy-named AND native approve permission). */
export function roleCanApproveType(role: MembershipRole, type: ApprovalDocumentType): boolean {
  return roleHasPermission(role, NATIVE_APPROVE_PERMISSION[type]);
}
