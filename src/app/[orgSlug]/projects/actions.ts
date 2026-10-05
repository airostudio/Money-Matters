"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ProjectService } from "@/domain/projects/project-service";
import { TimesheetService } from "@/domain/projects/timesheet-service";
import { ProjectTimeBillingService } from "@/domain/projects/project-time-billing-service";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createProjectAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor, org } = await requireOrgAndActor(orgSlug);
    const customerContactId = String(formData.get("customerContactId") ?? "").trim() || undefined;

    let created;
    try {
      created = await ProjectService.create(actor, {
        customerContactId,
        code: String(formData.get("code") ?? "").trim(),
        name: String(formData.get("name") ?? "").trim(),
        currency: org.baseCurrency,
        budgetedRevenue: String(formData.get("budgetedRevenue") ?? "0"),
        budgetedCost: String(formData.get("budgetedCost") ?? "0"),
        defaultHourlyRate: (String(formData.get("defaultHourlyRate") ?? "").trim() || undefined) as string | undefined,
        startDate: formData.get("startDate") ? new Date(String(formData.get("startDate"))) : undefined,
        endDate: formData.get("endDate") ? new Date(String(formData.get("endDate"))) : undefined,
        memo: (String(formData.get("memo") ?? "").trim() || undefined) as string | undefined,
      });
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      redirectWithError(`/${orgSlug}/projects/new`, error);
    }

    revalidatePath(`/${orgSlug}/projects`);
    redirect(`/${orgSlug}/projects/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function setProjectStatusAction(orgSlug: string, projectId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    const status = String(formData.get("status") ?? "") as "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
    try {
      await ProjectService.setStatus(actor, projectId, status);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function createProjectTaskAction(orgSlug: string, projectId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await ProjectService.createTask(actor, projectId, {
        name: String(formData.get("name") ?? "").trim(),
        budgetedHours: (String(formData.get("budgetedHours") ?? "").trim() || undefined) as string | undefined,
        billingRate: (String(formData.get("billingRate") ?? "").trim() || undefined) as string | undefined,
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function createManualTimeAction(orgSlug: string, projectId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await TimesheetService.createManual(actor, {
        employeeUserId: actor.userId,
        projectId,
        taskId: (String(formData.get("taskId") ?? "").trim() || undefined) as string | undefined,
        entryDate: new Date(String(formData.get("entryDate") ?? "")),
        hours: String(formData.get("hours") ?? "0"),
        notes: (String(formData.get("notes") ?? "").trim() || undefined) as string | undefined,
        billable: formData.get("billable") === "on",
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function startTimerAction(orgSlug: string, projectId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await TimesheetService.startTimer(actor, {
        employeeUserId: actor.userId,
        projectId,
        taskId: (String(formData.get("taskId") ?? "").trim() || undefined) as string | undefined,
        billable: formData.get("billable") === "on",
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function stopTimerAction(orgSlug: string, projectId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await TimesheetService.stopTimer(actor, actor.userId);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function submitTimeEntryAction(orgSlug: string, projectId: string, entryId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await TimesheetService.submit(actor, entryId);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function approveTimeEntryAction(orgSlug: string, projectId: string, entryId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    try {
      await TimesheetService.approve(actor, entryId);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function rejectTimeEntryAction(orgSlug: string, projectId: string, entryId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    try {
      await TimesheetService.reject(actor, entryId, reason);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function createInvoiceFromUnbilledTimeAction(
  orgSlug: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/projects/${projectId}`;

    let result;
    try {
      result = await ProjectTimeBillingService.createInvoiceFromUnbilledTime(actor, {
        projectId,
        from: formData.get("from") ? new Date(String(formData.get("from"))) : undefined,
        to: formData.get("to") ? new Date(String(formData.get("to"))) : undefined,
        issueDate: new Date(String(formData.get("issueDate") ?? "")),
        dueDate: new Date(String(formData.get("dueDate") ?? "")),
        arAccountId: String(formData.get("arAccountId") ?? ""),
        revenueAccountId: String(formData.get("revenueAccountId") ?? ""),
        taxCodeId: (String(formData.get("taxCodeId") ?? "").trim() || undefined) as string | undefined,
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }

    revalidatePath(returnPath);
    redirect(`/${orgSlug}/sales/invoices/${result.invoice.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
