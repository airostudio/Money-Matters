"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierPaymentAllocationService } from "@/domain/purchases/supplier-payment-service";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { UnacknowledgedMatchDiscrepancyError } from "@/domain/purchases/errors";
import { paymentMethodEnum } from "@/db/schema";
import type { BillLineInput, PurchaseOrderLineInput, RecurringBillTemplateLineInput } from "@/domain/purchases/types";

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

// ---------------------------------------------------------------------------
// Purchase orders + three-way matching
// ---------------------------------------------------------------------------

function parsePoLinesFromFormData(formData: FormData): PurchaseOrderLineInput[] {
  const descriptions = formData.getAll("lineDescription").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const unitPrices = formData.getAll("lineUnitPrice").map(String);
  const accountIds = formData.getAll("lineAccountId").map(String);
  const taxCodeIds = formData.getAll("lineTaxCodeId").map(String);

  const lines: PurchaseOrderLineInput[] = [];
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

export async function createPurchaseOrderAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const input = {
    supplierContactId: String(formData.get("supplierContactId") ?? ""),
    issueDate: new Date(String(formData.get("issueDate") ?? "")),
    expectedDate: formData.get("expectedDate") ? new Date(String(formData.get("expectedDate"))) : undefined,
    currency: org.baseCurrency,
    memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
    lines: parsePoLinesFromFormData(formData),
  };

  let created;
  try {
    created = await PurchaseOrderService.create(actor, input);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create purchase order.";
    redirect(`/${orgSlug}/purchases/purchase-orders/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/purchases/purchase-orders`);
  redirect(`/${orgSlug}/purchases/purchase-orders/${created.id}`);
}

export async function markPoSentAction(orgSlug: string, poId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/purchase-orders/${poId}`;
  try {
    await PurchaseOrderService.markSent(actor, poId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send purchase order.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function cancelPoAction(orgSlug: string, poId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/purchases/purchase-orders/${poId}`;
  try {
    await PurchaseOrderService.cancel(actor, poId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to cancel purchase order.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function recordPoReceiptAction(orgSlug: string, poId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/purchase-orders/${poId}`;

  const lineIds = formData.getAll("receiptLineId").map(String);
  const quantities = formData.getAll("receiptQuantity").map(String);
  const lines = lineIds
    .map((purchaseOrderLineId, i) => ({ purchaseOrderLineId, quantityReceived: quantities[i] ?? "0" }))
    .filter((l) => l.purchaseOrderLineId && Number(l.quantityReceived) > 0);

  if (lines.length === 0) {
    redirect(`${returnPath}?error=${encodeURIComponent("Enter a received quantity for at least one line.")}`);
  }

  try {
    await PurchaseOrderService.recordReceipt(actor, poId, { receivedDate: new Date(String(formData.get("receivedDate") ?? "")), lines });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record receipt.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function convertPoToBillAction(orgSlug: string, poId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/purchase-orders/${poId}`;

  const poLineIds = formData.getAll("billPoLineId").map(String);
  const quantities = formData.getAll("billQuantity").map(String);
  const unitPrices = formData.getAll("billUnitPrice").map(String);
  const lines = poLineIds.map((poLineId, i) => ({ poLineId, quantity: quantities[i] ?? "0", unitPrice: unitPrices[i] ?? "0" }));
  const acknowledgeDiscrepancies = formData.get("acknowledgeDiscrepancies") === "on";

  try {
    const result = await PurchaseOrderService.convertToBill(actor, poId, {
      issueDate: new Date(String(formData.get("issueDate") ?? "")),
      dueDate: new Date(String(formData.get("dueDate") ?? "")),
      apAccountId: String(formData.get("apAccountId") ?? ""),
      supplierReference: (formData.get("supplierReference") ? String(formData.get("supplierReference")).trim() : undefined) || undefined,
      lines,
      acknowledgeDiscrepancies,
    });
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/purchases/bills`);
    redirect(`/${orgSlug}/purchases/bills/${result.id}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    if (error instanceof UnacknowledgedMatchDiscrepancyError) {
      const preview = await PurchaseOrderService.previewMatch(actor, poId, lines);
      const details = preview.discrepancies.map((d) => d.message).join(" ");
      redirect(
        `${returnPath}?error=${encodeURIComponent(`The three-way match found differences — review and check "proceed anyway" to confirm: ${details}`)}&mismatch=1`,
      );
    }
    const message = error instanceof Error ? error.message : "Failed to convert to a bill.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
}

// ---------------------------------------------------------------------------
// Recurring bills
// ---------------------------------------------------------------------------

function parseRecurringBillLines(formData: FormData): RecurringBillTemplateLineInput[] {
  const descriptions = formData.getAll("lineDescription").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  const unitPrices = formData.getAll("lineUnitPrice").map(String);
  const accountIds = formData.getAll("lineAccountId").map(String);
  const taxCodeIds = formData.getAll("lineTaxCodeId").map(String);

  const lines: RecurringBillTemplateLineInput[] = [];
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

export async function createRecurringBillAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const maxOccurrencesRaw = String(formData.get("maxOccurrences") ?? "").trim();

  let created;
  try {
    created = await RecurringBillService.create(actor, {
      supplierContactId: String(formData.get("supplierContactId") ?? ""),
      name: String(formData.get("name") ?? ""),
      currency: org.baseCurrency,
      apAccountId: String(formData.get("apAccountId") ?? ""),
      memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
      frequency: String(formData.get("frequency") ?? "MONTHLY") as never,
      startDate: new Date(String(formData.get("startDate") ?? "")),
      endDate: formData.get("endDate") ? new Date(String(formData.get("endDate"))) : undefined,
      maxOccurrences: maxOccurrencesRaw ? Number(maxOccurrencesRaw) : undefined,
      lines: parseRecurringBillLines(formData),
    });
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create recurring bill template.";
    redirect(`/${orgSlug}/purchases/recurring-bills/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/purchases/recurring-bills`);
  redirect(`/${orgSlug}/purchases/recurring-bills/${created.id}`);
}

export async function setRecurringBillActiveAction(orgSlug: string, templateId: string, isActive: boolean): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/recurring-bills/${templateId}`;
  await RecurringBillService.setActive(actor, templateId, isActive);
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function deleteRecurringBillAction(orgSlug: string, templateId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  try {
    await RecurringBillService.deleteTemplate(actor, templateId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete template.";
    redirect(`/${orgSlug}/purchases/recurring-bills/${templateId}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(`/${orgSlug}/purchases/recurring-bills`);
  redirect(`/${orgSlug}/purchases/recurring-bills`);
}

export async function generateDueBillsAction(orgSlug: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/recurring-bills`;
  const generated = await RecurringBillService.generateDue(actor);
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/purchases/bills`);
  redirect(`${returnPath}?generated=${generated.length}`);
}

// ---------------------------------------------------------------------------
// Supplier credits
// ---------------------------------------------------------------------------

export async function createSupplierCreditAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  let created;
  try {
    created = await SupplierCreditService.create(actor, {
      supplierContactId: String(formData.get("supplierContactId") ?? ""),
      issueDate: new Date(String(formData.get("issueDate") ?? "")),
      currency: org.baseCurrency,
      apAccountId: String(formData.get("apAccountId") ?? ""),
      memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
      lines: parseLinesFromFormData(formData),
    });
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create credit note.";
    redirect(`/${orgSlug}/purchases/supplier-credits/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/purchases/supplier-credits`);
  redirect(`/${orgSlug}/purchases/supplier-credits/${created.id}`);
}

export async function approveAndPostCreditAction(orgSlug: string, creditId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/supplier-credits/${creditId}`;
  try {
    await SupplierCreditService.approveAndPost(actor, creditId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post credit note.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function voidCreditAction(orgSlug: string, creditId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/purchases/supplier-credits/${creditId}`;
  try {
    await SupplierCreditService.voidCredit(actor, creditId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to void credit note.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function applyCreditToBillAction(orgSlug: string, creditId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/supplier-credits/${creditId}`;
  const billId = String(formData.get("billId") ?? "");
  const amount = String(formData.get("amount") ?? "0");
  try {
    await SupplierCreditService.applyToBill(actor, creditId, billId, amount);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply credit note.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/purchases/bills/${billId}`);
  redirect(returnPath);
}

// ---------------------------------------------------------------------------
// Payment runs with segregation of duties
// ---------------------------------------------------------------------------

export async function createPaymentRunAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  const billIds = formData.getAll("billId").map(String);

  let created;
  try {
    created = await PaymentRunService.create(actor, {
      paymentDate: new Date(String(formData.get("paymentDate") ?? "")),
      currency: org.baseCurrency,
      paymentAccountId: String(formData.get("paymentAccountId") ?? ""),
      memo: (formData.get("memo") ? String(formData.get("memo")).trim() : undefined) || undefined,
      billIds,
    });
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "Failed to create payment run.";
    redirect(`/${orgSlug}/purchases/payment-runs/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/purchases/payment-runs`);
  redirect(`/${orgSlug}/purchases/payment-runs/${created!.id}`);
}

export async function submitPaymentRunAction(orgSlug: string, runId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/payment-runs/${runId}`;
  try {
    await PaymentRunService.submitForApproval(actor, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit for approval.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function approvePaymentRunAction(orgSlug: string, runId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/purchases/payment-runs/${runId}`;
  try {
    await PaymentRunService.approve(actor, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve payment run.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/purchases/bills`);
  redirect(returnPath);
}

export async function cancelPaymentRunAction(orgSlug: string, runId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const returnPath = `/${orgSlug}/purchases/payment-runs/${runId}`;
  try {
    await PaymentRunService.cancel(actor, runId, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to cancel payment run.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}
