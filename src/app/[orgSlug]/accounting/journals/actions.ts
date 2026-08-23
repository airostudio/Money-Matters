"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";

function parseLinesFromFormData(formData: FormData): JournalLineDraft[] {
  const accountIds = formData.getAll("lineAccountId").map(String);
  const debits = formData.getAll("lineDebit").map(String);
  const credits = formData.getAll("lineCredit").map(String);
  const memos = formData.getAll("lineMemo").map(String);
  const currencies = formData.getAll("lineCurrency").map(String);

  const lines: JournalLineDraft[] = [];
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    if (!accountId) continue;
    const debit = debits[i]?.trim();
    const credit = credits[i]?.trim();
    if (!debit && !credit) continue;

    lines.push({
      accountId,
      debit: debit || undefined,
      credit: credit || undefined,
      currency: currencies[i] || "AUD",
      memo: memos[i]?.trim() || undefined,
    });
  }
  return lines;
}

function parseCommonFields(formData: FormData) {
  const postingDateRaw = formData.get("postingDate");
  const memo = formData.get("memo");
  return {
    postingDate: postingDateRaw ? new Date(String(postingDateRaw)) : new Date(),
    memo: memo ? String(memo).trim() || undefined : undefined,
  };
}

async function handleJournalSubmit(
  orgSlug: string,
  formData: FormData,
  mode: "post" | "draft",
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const { postingDate, memo } = parseCommonFields(formData);
  const lines = parseLinesFromFormData(formData);

  const draft = { postingDate, memo, lines };

  try {
    const result =
      mode === "post"
        ? await PostingService.postJournal(actor, draft)
        : await PostingService.createDraft(actor, draft);

    revalidatePath(`/${orgSlug}/accounting/journals`);
    redirect(`/${orgSlug}/accounting/journals/${result.entryId}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error; // let redirect() propagate
    const message = error instanceof Error ? error.message : "Failed to save journal entry.";
    redirect(`/${orgSlug}/accounting/journals/new?error=${encodeURIComponent(message)}`);
  }
}

export async function postJournalAction(orgSlug: string, formData: FormData): Promise<void> {
  await handleJournalSubmit(orgSlug, formData, "post");
}

export async function saveDraftAction(orgSlug: string, formData: FormData): Promise<void> {
  await handleJournalSubmit(orgSlug, formData, "draft");
}

export async function postDraftAction(orgSlug: string, entryId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await PostingService.postDraft(actor, entryId);
  revalidatePath(`/${orgSlug}/accounting/journals/${entryId}`);
}

export async function deleteDraftAction(orgSlug: string, entryId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await PostingService.deleteDraft(actor, entryId);
  revalidatePath(`/${orgSlug}/accounting/journals`);
  redirect(`/${orgSlug}/accounting/journals`);
}

export async function reverseEntryAction(orgSlug: string, entryId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const result = await PostingService.reverseEntry(actor, entryId, reason);
  revalidatePath(`/${orgSlug}/accounting/journals/${entryId}`);
  redirect(`/${orgSlug}/accounting/journals/${result.entryId}`);
}
