"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierPaymentAllocationService } from "@/domain/purchases/supplier-payment-service";
import { paymentMethodEnum } from "@/db/schema";
import type { BillLineInput } from "@/domain/purchases/types";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

const CreateSupplierSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional(),
  taxNumber: z.string().trim().max(50).optional(),
});

export async function createSupplierAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const parsed = CreateSupplierSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email") || undefined,
    phone: formData.get("phone") || undefined,
    taxNumber: formData.get("taxNumber") || undefined,
  });
  if (!parsed.success) {
    redirectWithError(`/${orgSlug}/purchases/suppliers/new`, new Error(parsed.error.issues[0]?.message ?? "Invalid input."));
  }

  let supplier;
  try {
    supplier = await ContactService.create(actor, {
      kind: "SUPPLIER",
      displayName: parsed.data.displayName,
      currency: org.baseCurrency,
      email: parsed.data.email || undefined,
      phone: parsed.data.phone || undefined,
      taxNumber: parsed.data.taxNumber || undefined,
    });
  } catch (error) {
    redirectWithError(`/${orgSlug}/purchases/suppliers/new`, error);
  }

  revalidatePath(`/${orgSlug}/purchases/suppliers`);
  redirect(`/${orgSlug}/purchases/suppliers/${supplier.id}`);
}

function parseLinesFromFormData(formData: FormData): BillLineInput[] {
  const descriptions = formData.getAll("lineDescription").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const unitPrices = formData.getAll("lineUnitPrice").map(String);
  const accountIds = formData.getAll("lineAccountId").map(String);
  const taxCodeIds = formData.getAll("lineTaxCodeId").map(String);

  const lines: BillLineInput[] = [];
  for (let i = 0; i < descriptions.length; i++) {
    if (!accountIds[i]) continue;
    lines.push({
      description: descriptions[i] ?? "",
      quantity: quantities[i] ?? "0",
      unitPrice: unitPrices[i] ?? "0",
      accountId: accountIds[i]!,
      taxCodeId: taxCodeIds[i] || undefined,
    });
  }
  return lines;
}

function parseBillHeader(formData: FormData, currency: string) {
  return {
    supplierContactId: String(formData.get("supplierContactId") ?? ""),
    issueDate: new Date(String(formData.get("issueDate") ?? "")),
    dueDate: new Date(String(formData.get("dueDate") ?? "")),
    currency,
    apAccountId: String(formData.get("apAccountId") ?? ""),
    memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
    supplierReference:
      (formData.get("supplierReference") ? String(formData.get("supplierReference")).trim() : undefined) || undefined,
    lines: parseLinesFromFormData(formData),
  };
}

export async function createBillAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const input = parseBillHeader(formData, org.baseCurrency);

  let created;
  try {
    created = await BillService.create(actor, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create bill.";
    redirect(`/${orgSlug}/purchases/bills/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/purchases/bills`);
  redirect(`/${orgSlug}/purchases/bills/${created.id}`);
}

export async function updateBillAction(orgSlug: string, billId: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const input = parseBillHeader(formData, org.baseCurrency);
  const returnPath = `/${orgSlug}/purchases/bills/${billId}`;

  try {
    await BillService.update(actor, billId, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to update bill.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function deleteDraftBillAction(orgSlug: string, billId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await BillService.deleteDraft(actor, billId);
  revalidatePath(`/${orgSlug}/purchases/bills`);
  redirect(`/${orgSlug}/purchases/bills`);
}

export async function approveAndPostBillAction(orgSlug: string, billId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/bills/${billId}`;
  try {
    await BillService.approveAndPost(actor, billId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post bill.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function voidBillAction(orgSlug: string, billId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/purchases/bills/${billId}`;
  try {
    await BillService.voidBill(actor, billId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to void bill.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

const PAYMENT_METHODS = new Set(paymentMethodEnum.enumValues);

export async function recordSupplierPaymentAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const supplierContactId = String(formData.get("supplierContactId") ?? "");
  const returnPath = formData.get("returnPath")
    ? String(formData.get("returnPath"))
    : `/${orgSlug}/purchases/suppliers/${supplierContactId}`;

  const methodRaw = String(formData.get("method") ?? "BANK_TRANSFER");
  const method = (PAYMENT_METHODS.has(methodRaw as never) ? methodRaw : "BANK_TRANSFER") as (typeof paymentMethodEnum.enumValues)[number];

  const billIds = formData.getAll("allocationBillId").map(String);
  const amounts = formData.getAll("allocationAmount").map(String);
  const allocations = billIds
    .map((billId, i) => ({ billId, amount: amounts[i] ?? "0" }))
    .filter((a) => a.billId && Number(a.amount) > 0);

  try {
    await SupplierPaymentAllocationService.recordPayment(actor, {
      supplierContactId,
      paymentDate: new Date(String(formData.get("paymentDate") ?? "")),
      amount: String(formData.get("amount") ?? "0"),
      currency: org.baseCurrency,
      method,
      paymentAccountId: String(formData.get("paymentAccountId") ?? ""),
      reference: (formData.get("reference") ? String(formData.get("reference")).trim() : undefined) || undefined,
      allocations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record payment.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/purchases/bills`);
  redirect(returnPath);
}
