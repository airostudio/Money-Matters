"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import { PeriodLockedError } from "@/domain/ledger/errors";
import { lockFailureQuery, postOptionsFromForm } from "@/lib/lock-feedback";

function parseLinesFromFormData(formData: FormData): JournalLineDraft[] {
  const accountIds = formData.getAll("lineAccountId").map(String);
  const debits = formData.getAll("lineDebit").map(String);
  const credits = formData.getAll("lineCredit").map(String);
  const memos = formData.getAll("lineMemo").map(String);
  const currencies = formData.getAll("lineCurrency").map(String);
  // Present only when the form rendered a dimension picker at all (see
  // JournalLineEditor's `dimensionOptions` prop) — absent entirely for an
  // org with no dimensions configured, so this stays an empty array rather
  // than misaligning with the other per-line arrays above.
  const dimensionValueIds = formData.getAll("lineDimensionValueId").map(String);

  const lines: JournalLineDraft[] = [];
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    if (!accountId) continue;
    const debit = debits[i]?.trim();
    const credit = credits[i]?.trim();
    if (!debit && !credit) continue;

    const dimensionValueId = dimensionValueIds[i]?.trim();

    lines.push({
      accountId,
      debit: debit || undefined,
      credit: credit || undefined,
      currency: currencies[i] || "AUD",
      memo: memos[i]?.trim() || undefined,
      dimensionValueIds: dimensionValueId ? [dimensionValueId] : undefined,
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
  const options = postOptionsFromForm(formData);

  try {
    const result =
      mode === "post"
        ? await PostingService.postJournal(actor, draft, options)
        : await PostingService.createDraft(actor, draft);

    revalidatePath(`/${orgSlug}/accounting/journals`);
    redirect(`/${orgSlug}/accounting/journals/${result.entryId}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error; // let redirect() propagate
    // The period is locked. Never lose what the user typed and never leave a dead end: keep the
    // entry as a DRAFT (drafts are allowed in locked periods) and land on it with the explained
    // reason — plus "Post anyway — reason required" when this user may override a soft lock.
    if (mode === "post" && error instanceof PeriodLockedError) {
      let draftId: string | null = null;
      try {
        draftId = (await PostingService.createDraft(actor, draft)).entryId;
      } catch {
        draftId = null;
      }
      if (draftId) redirect(`/${orgSlug}/accounting/journals/${draftId}?${lockFailureQuery(error)}`);
    }
    const message = error instanceof Error ? error.message : "Failed to save journal entry.";
    redirect(`/${orgSlug}/accounting/journals/new?error=${encodeURIComponent(message)}`);
  }
}

export async function postJournalAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    await handleJournalSubmit(orgSlug, formData, "post");
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function saveDraftAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    await handleJournalSubmit(orgSlug, formData, "draft");
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function postDraftAction(orgSlug: string, entryId: string, formData?: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/accounting/journals/${entryId}`;
    try {
      await PostingService.postDraft(actor, entryId, postOptionsFromForm(formData));
    } catch (error) {
      const query = lockFailureQuery(error);
      if (query) redirect(`${returnPath}?${query}`);
      throw error;
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function deleteDraftAction(orgSlug: string, entryId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    await PostingService.deleteDraft(actor, entryId);
    revalidatePath(`/${orgSlug}/accounting/journals`);
    redirect(`/${orgSlug}/accounting/journals`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function reverseEntryAction(orgSlug: string, entryId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const result = await PostingService.reverseEntry(actor, entryId, reason);
    revalidatePath(`/${orgSlug}/accounting/journals/${entryId}`);
    redirect(`/${orgSlug}/accounting/journals/${result.entryId}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
