"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { BasService } from "@/domain/tax/bas-service";
import { calendarPeriod } from "@/domain/tax/bas-calculations";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createBasDraftAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/accounting/bas`;
    const frequency = String(formData.get("frequency") ?? "QUARTERLY") === "MONTHLY" ? "MONTHLY" : "QUARTERLY";
    const year = Number(formData.get("year"));
    const index = Number(formData.get("index"));
    const customStart = String(formData.get("periodStart") ?? "").trim();
    const customEnd = String(formData.get("periodEnd") ?? "").trim();
    let created;
    try {
      const period =
        customStart && customEnd
          ? { start: customStart, end: customEnd }
          : calendarPeriod(frequency, year, index);
      created = await BasService.createDraft(actor, {
        periodStart: period.start,
        periodEnd: period.end,
        frequency,
        basis: String(formData.get("basis") ?? "ACCRUAL"),
        note: String(formData.get("note") ?? ""),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(`${returnPath}/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function deleteBasDraftAction(orgSlug: string, id: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/accounting/bas`;
    try {
      await BasService.deleteDraft(actor, id);
    } catch (error) {
      redirectWithError(`${returnPath}/${id}`, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function finaliseBasAction(orgSlug: string, id: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const path = `/${orgSlug}/accounting/bas/${id}`;
    try {
      await BasService.finalise(actor, id, { acknowledgeWarnings: formData.get("acknowledge") === "on" });
    } catch (error) {
      redirectWithError(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function markBasLodgedAction(orgSlug: string, id: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const path = `/${orgSlug}/accounting/bas/${id}`;
    try {
      await BasService.markLodgedOutside(actor, id, {
        lodgedOn: String(formData.get("lodgedOn") ?? ""),
        reference: String(formData.get("reference") ?? ""),
      });
    } catch (error) {
      redirectWithError(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
