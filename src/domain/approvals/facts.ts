import { and, eq } from "drizzle-orm";
import { billLines, bills, contacts, expenseClaimLines, expenseClaims, paymentRunItems, paymentRuns } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { ApprovalDocumentNotReadyError } from "./errors";
import type { ApprovalDocumentType, DocumentFacts } from "./policy";

/** Everything the engine needs to know about a document: policy-matching facts plus how to show it in an inbox. */
export interface LoadedDocument {
  facts: DocumentFacts;
  label: string;
  summary: string;
  /** People who can never decide the request, whatever their role: the document's own creator / claimant. */
  excludedUserIds: string[];
  /** The document's current status, and the one the engine expects when a request is opened. */
  status: string;
  expectedStatus: string;
}

const uniq = <T>(values: Array<T | null | undefined>): T[] => [...new Set(values.filter((v): v is T => v !== null && v !== undefined))];

/** Loads a document's facts inside the caller's tenant transaction. Returns null when it does not exist in this organization. */
export async function loadDocument(tx: TenantDb, organizationId: string, type: ApprovalDocumentType, documentId: string): Promise<LoadedDocument | null> {
  if (type === "SUPPLIER_BILL") {
    const [bill] = await tx.select().from(bills).where(and(eq(bills.organizationId, organizationId), eq(bills.id, documentId)));
    if (!bill) return null;
    const lines = await tx.select({ accountId: billLines.accountId, projectId: billLines.projectId }).from(billLines).where(eq(billLines.billId, bill.id));
    const [supplier] = await tx.select({ name: contacts.displayName }).from(contacts).where(eq(contacts.id, bill.supplierContactId));
    return {
      facts: {
        documentType: type,
        amount: bill.total,
        currency: bill.currency,
        supplierContactIds: [bill.supplierContactId],
        accountIds: uniq(lines.map((l) => l.accountId)),
        projectIds: uniq(lines.map((l) => l.projectId)),
        raisedByUserId: bill.createdById ?? null,
      },
      label: bill.billNumber,
      summary: `${supplier?.name ?? "Supplier"} - ${bill.currency} ${bill.total}`,
      excludedUserIds: uniq([bill.createdById]),
      status: bill.status,
      expectedStatus: "DRAFT",
    };
  }
  if (type === "EXPENSE_CLAIM") {
    const [claim] = await tx.select().from(expenseClaims).where(and(eq(expenseClaims.organizationId, organizationId), eq(expenseClaims.id, documentId)));
    if (!claim) return null;
    const lines = await tx
      .select({ accountId: expenseClaimLines.expenseAccountId, projectId: expenseClaimLines.projectId })
      .from(expenseClaimLines)
      .where(eq(expenseClaimLines.expenseClaimId, claim.id));
    return {
      facts: {
        documentType: type,
        amount: claim.total,
        currency: claim.currency,
        supplierContactIds: [],
        accountIds: uniq(lines.map((l) => l.accountId)),
        projectIds: uniq(lines.map((l) => l.projectId)),
        raisedByUserId: claim.employeeUserId,
      },
      label: claim.claimNumber,
      summary: `${claim.description} - ${claim.currency} ${claim.total}`,
      excludedUserIds: uniq([claim.employeeUserId, claim.submittedById]),
      status: claim.status,
      expectedStatus: "SUBMITTED",
    };
  }
  const [run] = await tx.select().from(paymentRuns).where(and(eq(paymentRuns.organizationId, organizationId), eq(paymentRuns.id, documentId)));
  if (!run) return null;
  const items = await tx
    .select({ supplierContactId: bills.supplierContactId })
    .from(paymentRunItems)
    .innerJoin(bills, eq(bills.id, paymentRunItems.billId))
    .where(eq(paymentRunItems.paymentRunId, run.id));
  return {
    facts: {
      documentType: type,
      amount: run.totalAmount,
      currency: run.currency,
      supplierContactIds: uniq(items.map((i) => i.supplierContactId)),
      accountIds: [run.paymentAccountId],
      projectIds: [],
      raisedByUserId: run.submittedById ?? run.createdById,
    },
    label: run.runNumber,
    summary: `${items.length} bill${items.length === 1 ? "" : "s"} - ${run.currency} ${run.totalAmount}`,
    excludedUserIds: uniq([run.createdById, run.submittedById]),
    status: run.status,
    expectedStatus: "AWAITING_APPROVAL",
  };
}

export function assertReadyForRequest(doc: LoadedDocument): void {
  if (doc.status !== doc.expectedStatus) {
    const nice = (s: string) => s.toLowerCase().replace(/_/g, " ");
    throw new ApprovalDocumentNotReadyError(`Approval can only be requested while the document is ${nice(doc.expectedStatus)} (it is ${nice(doc.status)}).`);
  }
}
