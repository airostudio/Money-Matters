"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { BankImportService } from "@/domain/banking/bank-import-service";
import { BankRuleService } from "@/domain/banking/bank-rule-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { bankImportFormatEnum } from "@/db/schema";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

const CreateBankAccountSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  glAccountId: z.string().uuid("Choose a ledger account"),
  currency: z.string().trim().min(1).max(10),
  institutionName: z.string().trim().max(200).optional(),
  accountNumberLast4: z.string().trim().max(4).optional(),
});

export async function createBankAccountAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const parsed = CreateBankAccountSchema.safeParse({
    name: formData.get("name"),
    glAccountId: formData.get("glAccountId"),
    currency: formData.get("currency") || org.baseCurrency,
    institutionName: formData.get("institutionName") || undefined,
    accountNumberLast4: formData.get("accountNumberLast4") || undefined,
  });
  if (!parsed.success) {
    redirectWithError(`/${orgSlug}/money/new`, new Error(parsed.error.issues[0]?.message ?? "Invalid input."));
  }

  try {
    await BankAccountService.create(actor, parsed.data);
  } catch (error) {
    redirectWithError(`/${orgSlug}/money/new`, error);
  }

  revalidatePath(`/${orgSlug}/money`);
  redirect(`/${orgSlug}/money`);
}

const FORMAT_BY_EXTENSION: Record<string, (typeof bankImportFormatEnum.enumValues)[number]> = {
  csv: "CSV",
  ofx: "OFX",
  qfx: "OFX",
  qif: "QIF",
};

export async function importStatementAction(
  orgSlug: string,
  bankAccountId: string,
  formData: FormData,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/money/${bankAccountId}`;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirectWithError(`${returnPath}/import`, new Error("Choose a statement file to import."));
  }

  const requestedFormat = formData.get("format");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const format =
    (requestedFormat && bankImportFormatEnum.enumValues.includes(requestedFormat as never)
      ? (requestedFormat as (typeof bankImportFormatEnum.enumValues)[number])
      : FORMAT_BY_EXTENSION[extension]) ?? null;

  if (!format) {
    redirectWithError(
      `${returnPath}/import`,
      new Error("Couldn't tell the file format from its extension — choose CSV, OFX, or QIF explicitly."),
    );
    return;
  }

  const text = await file.text();

  let result;
  try {
    result = await BankImportService.importStatement(actor, {
      bankAccountId,
      format,
      fileName: file.name,
      text,
    });
  } catch (error) {
    redirectWithError(`${returnPath}/import`, error);
  }

  revalidatePath(returnPath);
  redirect(
    `${returnPath}?imported=${result.importedRowCount}&duplicates=${result.duplicateRowCount}` +
      (result.warnings.length > 0 ? `&warnings=${encodeURIComponent(result.warnings.join("; "))}` : ""),
  );
}

export async function createJournalFromTransactionAction(
  orgSlug: string,
  bankAccountId: string,
  bankTransactionId: string,
  formData: FormData,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/money/${bankAccountId}`;

  const categorizedAccountId = formData.get("categorizedAccountId");
  if (typeof categorizedAccountId !== "string" || categorizedAccountId.length === 0) {
    redirectWithError(returnPath, new Error("Choose an account to categorize this transaction to."));
    return;
  }

  try {
    await ReconciliationService.createJournalFromTransaction(actor, bankTransactionId, {
      categorizedAccountId,
    });
  } catch (error) {
    redirectWithError(returnPath, error);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function confirmMatchAction(
  orgSlug: string,
  bankAccountId: string,
  bankTransactionId: string,
  journalLineId: string,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await ReconciliationService.confirmMatch(actor, bankTransactionId, journalLineId);
  revalidatePath(`/${orgSlug}/money/${bankAccountId}`);
}

export async function excludeTransactionAction(
  orgSlug: string,
  bankAccountId: string,
  bankTransactionId: string,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await ReconciliationService.exclude(actor, bankTransactionId);
  revalidatePath(`/${orgSlug}/money/${bankAccountId}`);
}

const CreateBankRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  descriptionContains: z.string().trim().min(1, "Enter text to match in the description"),
  categorizedAccountId: z.string().uuid("Choose an account"),
});

export async function createBankRuleAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const parsed = CreateBankRuleSchema.safeParse({
    name: formData.get("name"),
    descriptionContains: formData.get("descriptionContains"),
    categorizedAccountId: formData.get("categorizedAccountId"),
  });
  if (!parsed.success) {
    redirectWithError(`/${orgSlug}/money/rules/new`, new Error(parsed.error.issues[0]?.message ?? "Invalid input."));
    return;
  }

  try {
    await BankRuleService.create(actor, {
      name: parsed.data.name,
      conditions: [{ field: "description", operator: "CONTAINS", value: parsed.data.descriptionContains }],
      actions: { categorizedAccountId: parsed.data.categorizedAccountId },
    });
  } catch (error) {
    redirectWithError(`/${orgSlug}/money/rules/new`, error);
  }

  revalidatePath(`/${orgSlug}/money/rules`);
  redirect(`/${orgSlug}/money/rules`);
}

export async function setBankRuleActiveAction(
  orgSlug: string,
  bankRuleId: string,
  isActive: boolean,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await BankRuleService.setActive(actor, bankRuleId, isActive);
  revalidatePath(`/${orgSlug}/money/rules`);
}
