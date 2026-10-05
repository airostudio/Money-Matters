"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { isLockLevel, type LockLevel } from "@/domain/ledger/period-lock";

/**
 * Every action here is a thin wrapper: the domain services own permission
 * checks, validation, auditing and the append-only history. These only read
 * the form, call the service, and turn any failure into a readable banner on
 * the period page (never a bare error screen). Closing, reopening and
 * locking are human-only critical actions — there is no AI path to any of
 * these (docs/ai-agents.md).
 */

function path(orgSlug: string, periodKey: string): string {
  return `/${orgSlug}/accounting/close/${periodKey}`;
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function level(formData: FormData, name: string): LockLevel | undefined {
  const value = field(formData, name);
  return isLockLevel(value) ? value : undefined;
}

async function run(
  orgSlug: string,
  periodKey: string,
  notice: string,
  work: (actor: Awaited<ReturnType<typeof requireOrgAndActor>>["actor"]) => Promise<unknown>,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = path(orgSlug, periodKey);
  try {
    await work(actor);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "That action could not be completed.";
    redirect(`${returnPath}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(returnPath);
  revalidatePath(`/${orgSlug}/accounting/close`);
  redirect(`${returnPath}?notice=${encodeURIComponent(notice)}`);
}

export async function signOffAction(orgSlug: string, periodKey: string, formData: FormData): Promise<void> {
  await run(orgSlug, periodKey, "Signed off. This is recorded as a person's sign-off, not a system check.", (actor) =>
    PeriodCloseService.signOff(actor, periodKey, field(formData, "checkKey"), field(formData, "note") || undefined),
  );
}

export async function revokeSignOffAction(orgSlug: string, periodKey: string, formData: FormData): Promise<void> {
  await run(orgSlug, periodKey, "Sign-off revoked.", (actor) =>
    PeriodCloseService.revokeSignOff(actor, periodKey, field(formData, "checkKey")),
  );
}

export async function closePeriodAction(orgSlug: string, periodKey: string, formData: FormData): Promise<void> {
  await run(orgSlug, periodKey, "Period closed.", (actor) =>
    PeriodCloseService.close(actor, periodKey, {
      lockLevel: level(formData, "lockLevel"),
      acknowledgeOutstanding: formData.get("acknowledgeOutstanding") === "on",
      note: field(formData, "note") || undefined,
    }),
  );
}

export async function raiseLockAction(orgSlug: string, periodKey: string, formData: FormData): Promise<void> {
  await run(orgSlug, periodKey, "Lock level raised.", (actor) =>
    PeriodLockService.raise(actor, periodKey, level(formData, "lockLevel") ?? "HARD_LOCKED", field(formData, "reason") || undefined),
  );
}

export async function reopenPeriodAction(orgSlug: string, periodKey: string, formData: FormData): Promise<void> {
  await run(orgSlug, periodKey, "Period reopened. The reason has been recorded in the lock history and audit log.", (actor) =>
    PeriodLockService.reopen(actor, periodKey, {
      reason: field(formData, "reason"),
      toLevel: level(formData, "toLevel") ?? "OPEN",
      acknowledgement: field(formData, "acknowledgement") || undefined,
    }),
  );
}
