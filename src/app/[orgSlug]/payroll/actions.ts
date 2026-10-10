"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import type { EmploymentBasis, PayFrequencyDb } from "@/domain/payroll/types";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function optionalString(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? "").trim();
  return value || undefined;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function createEmployeeAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/payroll/employees/new`;
    const employmentBasis = String(formData.get("employmentBasis") ?? "SALARY") as EmploymentBasis;

    let created;
    try {
      created = await EmployeeService.create(actor, {
        name: String(formData.get("name") ?? "").trim(),
        employmentBasis,
        annualSalary: optionalString(formData, "annualSalary"),
        hourlyRate: optionalString(formData, "hourlyRate"),
        standardHoursPerWeek: optionalString(formData, "standardHoursPerWeek"),
        payFrequency: String(formData.get("payFrequency") ?? "FORTNIGHTLY") as PayFrequencyDb,
        taxFreeThresholdClaimed: formData.get("taxFreeThresholdClaimed") === "on",
        taxResidency: String(formData.get("taxResidency") ?? "RESIDENT") === "FOREIGN_RESIDENT" ? "FOREIGN_RESIDENT" : "RESIDENT",
        startDate: new Date(String(formData.get("startDate") ?? "")),
        userId: optionalString(formData, "userId"),
        tfn: optionalString(formData, "tfn"),
        superFundName: optionalString(formData, "superFundName"),
        superFundAbn: optionalString(formData, "superFundAbn"),
        superMemberAccountNumber: optionalString(formData, "superMemberAccountNumber"),
        bankAccountName: optionalString(formData, "bankAccountName"),
        bankBsb: optionalString(formData, "bankBsb"),
        bankAccountNumber: optionalString(formData, "bankAccountNumber"),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(`/${orgSlug}/payroll/employees`);
    redirect(`/${orgSlug}/payroll/employees/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function terminateEmployeeAction(orgSlug: string, employeeId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/payroll/employees/${employeeId}`;
    try {
      await EmployeeService.terminate(actor, employeeId, new Date(String(formData.get("terminationDate") ?? "")));
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

export async function createPayRunAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/payroll/pay-runs/new`;

    const employeeIds = formData.getAll("employeeIds").map(String).filter(Boolean);
    const manualHoursByEmployeeId: Record<string, string> = {};
    for (const employeeId of employeeIds) {
      const hours = optionalString(formData, `manualHours_${employeeId}`);
      if (hours) manualHoursByEmployeeId[employeeId] = hours;
    }

    let created;
    try {
      created = await PayRunService.create(
        actor,
        {
          payFrequency: String(formData.get("payFrequency") ?? "FORTNIGHTLY") as PayFrequencyDb,
          periodStart: new Date(String(formData.get("periodStart") ?? "")),
          periodEnd: new Date(String(formData.get("periodEnd") ?? "")),
          payDate: new Date(String(formData.get("payDate") ?? "")),
          employeeIds,
          manualHoursByEmployeeId,
          legacyQuarterlySuper: formData.get("legacyQuarterlySuper") === "on",
        },
        {
          wagesExpenseAccountId: String(formData.get("wagesExpenseAccountId") ?? ""),
          superannuationExpenseAccountId: String(formData.get("superannuationExpenseAccountId") ?? ""),
          paygWithholdingPayableAccountId: String(formData.get("paygWithholdingPayableAccountId") ?? ""),
          superannuationPayableAccountId: String(formData.get("superannuationPayableAccountId") ?? ""),
          netWagesPayableAccountId: String(formData.get("netWagesPayableAccountId") ?? ""),
        },
      );
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(`/${orgSlug}/payroll/pay-runs`);
    redirect(`/${orgSlug}/payroll/pay-runs/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function postPayRunAction(orgSlug: string, payRunId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/payroll/pay-runs/${payRunId}`;
    try {
      await PayRunService.post(actor, payRunId);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function discardPayRunDraftAction(orgSlug: string, payRunId: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await PayRunService.discardDraft(actor, payRunId);
    } catch (error) {
      redirectWithError(`/${orgSlug}/payroll/pay-runs`, error);
    }
    revalidatePath(`/${orgSlug}/payroll/pay-runs`);
    redirect(`/${orgSlug}/payroll/pay-runs`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
