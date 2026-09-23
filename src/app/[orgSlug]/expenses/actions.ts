"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { ReceiptService } from "@/domain/documents/receipt-service";
import type { ExpenseClaimLineInput } from "@/domain/expenses/types";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function parseLinesFromFormData(formData: FormData): ExpenseClaimLineInput[] {
  const descriptions = formData.getAll("lineDescription").map(String);
  const amounts = formData.getAll("lineAmount").map(String);
  const expenseAccountIds = formData.getAll("lineExpenseAccountId").map(String);
  const taxCodeIds = formData.getAll("lineTaxCodeId").map(String);
  const categories = formData.getAll("lineCategory").map(String);
  const receiptIds = formData.getAll("lineReceiptId").map(String);

  const lines: ExpenseClaimLineInput[] = [];
  for (let i = 0; i < descriptions.length; i++) {
    if (!expenseAccountIds[i]) continue;
    lines.push({
      description: descriptions[i] ?? "",
      amount: amounts[i] ?? "0",
      expenseAccountId: expenseAccountIds[i]!,
      taxCodeId: taxCodeIds[i] || undefined,
      category: categories[i] || undefined,
      receiptId: receiptIds[i] || undefined,
    });
  }
  return lines;
}

function parseClaimHeader(formData: FormData, currency: string, employeeUserId: string) {
  return {
    employeeUserId,
    claimDate: new Date(String(formData.get("claimDate") ?? "")),
    description: String(formData.get("description") ?? "").trim(),
    currency,
    payableAccountId: String(formData.get("payableAccountId") ?? ""),
    memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
    lines: parseLinesFromFormData(formData),
  };
}

export async function createExpenseClaimAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const employeeUserId = String(formData.get("employeeUserId") ?? actor.userId) || actor.userId;
  const input = parseClaimHeader(formData, org.baseCurrency, employeeUserId);

  let created;
  try {
    created = await ExpenseClaimService.create(actor, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create expense claim.";
    redirect(`/${orgSlug}/expenses/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/expenses`);
  redirect(`/${orgSlug}/expenses/${created.id}`);
}

export async function updateExpenseClaimAction(orgSlug: string, claimId: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  const existing = await ExpenseClaimService.get(actor, claimId);
  const employeeUserId = existing?.employeeUserId ?? actor.userId;
  const input = parseClaimHeader(formData, org.baseCurrency, employeeUserId);

  try {
    await ExpenseClaimService.update(actor, claimId, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to update expense claim.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function deleteDraftExpenseClaimAction(orgSlug: string, claimId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await ExpenseClaimService.deleteDraft(actor, claimId);
  revalidatePath(`/${orgSlug}/expenses`);
  redirect(`/${orgSlug}/expenses`);
}

export async function submitExpenseClaimAction(orgSlug: string, claimId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  try {
    await ExpenseClaimService.submit(actor, claimId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit expense claim.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function approveExpenseClaimAction(orgSlug: string, claimId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  try {
    await ExpenseClaimService.approve(actor, claimId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve expense claim.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function rejectExpenseClaimAction(orgSlug: string, claimId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  try {
    await ExpenseClaimService.reject(actor, claimId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject expense claim.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function markReimbursedExpenseClaimAction(orgSlug: string, claimId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  try {
    await ExpenseClaimService.markReimbursed(actor, claimId, {
      reimbursementAccountId: String(formData.get("reimbursementAccountId") ?? ""),
      reimbursementDate: new Date(String(formData.get("reimbursementDate") ?? "")),
      reference: (formData.get("reference") ? String(formData.get("reference")).trim() : undefined) || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark expense claim reimbursed.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function voidExpenseClaimAction(orgSlug: string, claimId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/expenses/${claimId}`;
  try {
    await ExpenseClaimService.voidClaim(actor, claimId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to void expense claim.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

/**
 * Uploads a receipt/invoice image or PDF, runs Document AI extraction
 * best-effort (see `ReceiptService.upload`), then redirects to the "new
 * expense claim" form with `receiptId` set so it can pre-fill an editable
 * draft — never posting or saving anything by itself. Master spec §17.
 */
export async function captureReceiptAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirectWithError(`/${orgSlug}/expenses/capture`, new Error("Choose a receipt image or PDF to upload."));
  }

  let receipt;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    receipt = await ReceiptService.upload(actor, { fileName: file.name, mimeType: file.type, data: buffer });
  } catch (error) {
    redirectWithError(`/${orgSlug}/expenses/capture`, error);
  }

  redirect(`/${orgSlug}/expenses/new?receiptId=${receipt.id}`);
}
