"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { monthlyColumns } from "@/domain/reporting/period-presets";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createBudgetAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets`;

  let created;
  try {
    created = await BudgetService.create(actor, {
      name: String(formData.get("name") ?? "").trim(),
      type: String(formData.get("type") ?? "BASELINE") as "BASELINE" | "REVISED_FORECAST" | "ROLLING_FORECAST",
      periodStart: new Date(String(formData.get("periodStart") ?? "")),
      periodEnd: new Date(String(formData.get("periodEnd") ?? "")),
      notes: String(formData.get("notes") ?? "").trim() || undefined,
    });
  } catch (error) {
    redirectWithError(`/${orgSlug}/budgets/new`, error);
  }

  revalidatePath(returnPath);
  redirect(`/${orgSlug}/budgets/${created.id}`);
}

/**
 * Bulk-entry save: one account's (optional dimension's) whole set of
 * monthly figures, submitted from the "enter a year at once" form on the
 * budget detail page — one call, not one per cell, per this slice's brief.
 * `month-<index>` inputs line up positionally with `monthlyColumns` of the
 * budget's own period, computed identically here and on the page that
 * renders the form.
 */
export async function setAccountLinesAction(orgSlug: string, budgetId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets/${budgetId}`;

  const accountId = String(formData.get("accountId") ?? "");
  const dimensionValueId = String(formData.get("dimensionValueId") ?? "").trim() || undefined;
  const periodStart = new Date(String(formData.get("periodStart") ?? ""));
  const periodEnd = new Date(String(formData.get("periodEnd") ?? ""));
  const columns = monthlyColumns({ from: periodStart, to: periodEnd });

  const months = columns
    .map((col, i) => ({ month: col.from, amount: String(formData.get(`month-${i}`) ?? "").trim() }))
    .filter((m) => m.amount !== "");

  try {
    if (!accountId) throw new Error("An account is required.");
    if (months.length === 0) throw new Error("Enter at least one month's amount.");
    await BudgetService.setAccountLines(actor, budgetId, { accountId, dimensionValueId, months });
  } catch (error) {
    redirectWithError(returnPath, error);
  }

  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function removeLineAction(orgSlug: string, budgetId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets/${budgetId}`;
  try {
    await BudgetService.removeLine(actor, budgetId, String(formData.get("lineId") ?? ""));
  } catch (error) {
    redirectWithError(returnPath, error);
  }
  revalidatePath(returnPath);
  redirect(returnPath);
}

export async function activateBudgetAction(orgSlug: string, budgetId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets/${budgetId}`;
  try {
    await BudgetService.activate(actor, budgetId);
  } catch (error) {
    redirectWithError(returnPath, error);
  }
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/budgets`);
  redirect(returnPath);
}

export async function archiveBudgetAction(orgSlug: string, budgetId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets/${budgetId}`;
  try {
    await BudgetService.archive(actor, budgetId);
  } catch (error) {
    redirectWithError(returnPath, error);
  }
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/budgets`);
  redirect(returnPath);
}

export async function createRollingForecastAction(orgSlug: string, sourceBudgetId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/budgets/${sourceBudgetId}/rolling-forecast`;

  let created;
  try {
    created = await BudgetService.createRollingForecast(actor, {
      sourceBudgetId,
      name: String(formData.get("name") ?? "").trim(),
      carryForwardAfterDate: new Date(String(formData.get("carryForwardAfterDate") ?? "")),
    });
  } catch (error) {
    redirectWithError(returnPath, error);
  }

  revalidatePath(`/${orgSlug}/budgets`);
  redirect(`/${orgSlug}/budgets/${created.id}`);
}
