"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { PayrollPaymentService } from "@/domain/payroll/payroll-payment-service";
import { LeaveService, type LeaveType } from "@/domain/payroll/leave-service";

function fail(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function dateOf(formData: FormData, key: string): Date {
  const d = new Date(`${text(formData, key)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error("Enter a valid date.");
  return d;
}

// ---------------------------------------------------------------------------
// Pay run reversal and net wages settlement
// ---------------------------------------------------------------------------

export async function reversePayRunAction(orgSlug: string, payRunId: string, formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/pay-runs/${payRunId}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await PayRunService.reverse(actor, payRunId, text(formData, "reason"));
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function payNetWagesAction(orgSlug: string, payRunId: string, formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/pay-runs/${payRunId}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await PayrollPaymentService.payNetWages(actor, payRunId, {
        bankAccountId: text(formData, "bankAccountId"),
        paymentDate: dateOf(formData, "paymentDate"),
        reference: text(formData, "reference"),
      });
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function reversePayrollPaymentAction(orgSlug: string, paymentId: string, returnTo: string, formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/${returnTo}`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await PayrollPaymentService.reverse(actor, paymentId, text(formData, "reason"));
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function recordRemittanceAction(orgSlug: string, kind: "SUPER" | "PAYG", formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/remittances`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      const input = {
        liabilityAccountId: text(formData, "liabilityAccountId"),
        bankAccountId: text(formData, "bankAccountId"),
        amount: text(formData, "amount"),
        paymentDate: dateOf(formData, "paymentDate"),
        reference: text(formData, "reference"),
      };
      if (kind === "SUPER") await PayrollPaymentService.recordSuperRemittance(actor, input);
      else await PayrollPaymentService.recordPaygRemittance(actor, input);
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export async function requestLeaveAction(orgSlug: string, formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/my`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await LeaveService.request(actor, {
        leaveType: (text(formData, "leaveType") === "PERSONAL" ? "PERSONAL" : "ANNUAL") as LeaveType,
        startDate: dateOf(formData, "startDate"),
        endDate: dateOf(formData, "endDate"),
        hours: text(formData, "hours"),
        reason: text(formData, "reason"),
      });
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function cancelLeaveAction(orgSlug: string, id: string): Promise<void> {
  const path = `/${orgSlug}/payroll/my`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await LeaveService.cancel(actor, id);
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function decideLeaveAction(orgSlug: string, id: string, decision: "approve" | "reject", formData: FormData): Promise<void> {
  const path = `/${orgSlug}/payroll/leave`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      if (decision === "approve") await LeaveService.approve(actor, id, text(formData, "note"));
      else await LeaveService.reject(actor, id, text(formData, "note"));
    } catch (error) {
      fail(path, error);
    }
    revalidatePath(path);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
