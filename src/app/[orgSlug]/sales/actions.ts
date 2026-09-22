"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { paymentMethodEnum } from "@/db/schema";
import type { InvoiceLineInput } from "@/domain/sales/types";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

const CreateCustomerSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional(),
  taxNumber: z.string().trim().max(50).optional(),
});

export async function createCustomerAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const parsed = CreateCustomerSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email") || undefined,
    phone: formData.get("phone") || undefined,
    taxNumber: formData.get("taxNumber") || undefined,
  });
  if (!parsed.success) {
    redirectWithError(`/${orgSlug}/sales/customers/new`, new Error(parsed.error.issues[0]?.message ?? "Invalid input."));
  }

  let customer;
  try {
    customer = await ContactService.create(actor, {
      kind: "CUSTOMER",
      displayName: parsed.data.displayName,
      currency: org.baseCurrency,
      email: parsed.data.email || undefined,
      phone: parsed.data.phone || undefined,
      taxNumber: parsed.data.taxNumber || undefined,
    });
  } catch (error) {
    redirectWithError(`/${orgSlug}/sales/customers/new`, error);
  }

  revalidatePath(`/${orgSlug}/sales/customers`);
  redirect(`/${orgSlug}/sales/customers/${customer.id}`);
}

function parseLinesFromFormData(formData: FormData): InvoiceLineInput[] {
  const descriptions = formData.getAll("lineDescription").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const unitPrices = formData.getAll("lineUnitPrice").map(String);
  const accountIds = formData.getAll("lineAccountId").map(String);
  const taxCodeIds = formData.getAll("lineTaxCodeId").map(String);

  const lines: InvoiceLineInput[] = [];
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

function parseInvoiceHeader(formData: FormData, currency: string) {
  return {
    customerContactId: String(formData.get("customerContactId") ?? ""),
    issueDate: new Date(String(formData.get("issueDate") ?? "")),
    dueDate: new Date(String(formData.get("dueDate") ?? "")),
    currency,
    arAccountId: String(formData.get("arAccountId") ?? ""),
    memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
    lines: parseLinesFromFormData(formData),
  };
}

export async function createInvoiceAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const input = parseInvoiceHeader(formData, org.baseCurrency);

  let created;
  try {
    created = await InvoiceService.create(actor, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create invoice.";
    redirect(`/${orgSlug}/sales/invoices/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/sales/invoices`);
  redirect(`/${orgSlug}/sales/invoices/${created.id}`);
}

export async function updateInvoiceAction(orgSlug: string, invoiceId: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const input = parseInvoiceHeader(formData, org.baseCurrency);
  const returnPath = `/${orgSlug}/sales/invoices/${invoiceId}`;

  try {
    await InvoiceService.update(actor, invoiceId, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to update invoice.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function deleteDraftInvoiceAction(orgSlug: string, invoiceId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await InvoiceService.deleteDraft(actor, invoiceId);
  revalidatePath(`/${orgSlug}/sales/invoices`);
  redirect(`/${orgSlug}/sales/invoices`);
}

export async function approveAndPostInvoiceAction(orgSlug: string, invoiceId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/sales/invoices/${invoiceId}`;
  try {
    await InvoiceService.approveAndPost(actor, invoiceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post invoice.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function markSentAction(orgSlug: string, invoiceId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await InvoiceService.markSent(actor, invoiceId);
  revalidatePath(`/${orgSlug}/sales/invoices/${invoiceId}`);
}

export async function voidInvoiceAction(orgSlug: string, invoiceId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/sales/invoices/${invoiceId}`;
  try {
    await InvoiceService.voidInvoice(actor, invoiceId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to void invoice.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

const PAYMENT_METHODS = new Set(paymentMethodEnum.enumValues);

export async function recordPaymentAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const customerContactId = String(formData.get("customerContactId") ?? "");
  const returnPath = formData.get("returnPath") ? String(formData.get("returnPath")) : `/${orgSlug}/sales/customers/${customerContactId}`;

  const methodRaw = String(formData.get("method") ?? "BANK_TRANSFER");
  const method = (PAYMENT_METHODS.has(methodRaw as never) ? methodRaw : "BANK_TRANSFER") as (typeof paymentMethodEnum.enumValues)[number];

  const invoiceIds = formData.getAll("allocationInvoiceId").map(String);
  const amounts = formData.getAll("allocationAmount").map(String);
  const allocations = invoiceIds
    .map((invoiceId, i) => ({ invoiceId, amount: amounts[i] ?? "0" }))
    .filter((a) => a.invoiceId && Number(a.amount) > 0);

  try {
    await PaymentAllocationService.recordPayment(actor, {
      customerContactId,
      paymentDate: new Date(String(formData.get("paymentDate") ?? "")),
      amount: String(formData.get("amount") ?? "0"),
      currency: org.baseCurrency,
      method,
      depositAccountId: String(formData.get("depositAccountId") ?? ""),
      reference: (formData.get("reference") ? String(formData.get("reference")).trim() : undefined) || undefined,
      allocations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record payment.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/sales/invoices`);
  redirect(returnPath);
}
