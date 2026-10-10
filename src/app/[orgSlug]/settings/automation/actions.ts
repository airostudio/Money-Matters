"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { requireOrgAndActor } from "@/lib/session";
import { AutomationEngine } from "@/domain/automation/engine";
import { AutomationRuleService, InvalidRuleError, RuleNotFoundError } from "@/domain/automation/rule-service";
import { ruleInputFromForm } from "./form";

/**
 * Server actions for Settings -> Automation. Every one resolves the HUMAN actor from the session and calls a service that
 * itself enforces `automation:manage` + human-only; a refusal redirects to the friendly access-denied page. The form is
 * translated into the closed rule shape here and validated again, field by field, by the service - nothing from the form
 * is interpreted as anything but a literal. Outcome messages travel as short fixed codes, never free text.
 */
export type RuleFormState = { status: "idle" } | { status: "error"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: FormDataEntryValue | null): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

export async function createRuleAction(orgSlug: string, _previous: RuleFormState, formData: FormData): Promise<RuleFormState> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    try {
      await AutomationRuleService.create(actor, ruleInputFromForm(formData));
    } catch (error) {
      if (error instanceof InvalidRuleError) return { status: "error", message: error.message };
      throw error;
    }
    revalidatePath(`/${orgSlug}/settings/automation`);
    redirect(`/${orgSlug}/settings/automation?notice=created`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function setRuleEnabledAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/automation`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("ruleId"));
    if (!id) return;
    const enabled = formData.get("enabled") === "true";
    try {
      await AutomationRuleService.setEnabled(actor, id, enabled, { acknowledgeWriteAction: formData.get("acknowledgeWriteAction") === "on" });
    } catch (error) {
      if (error instanceof RuleNotFoundError) return;
      if (error instanceof InvalidRuleError) redirect(`${back}?notice=${formData.get("acknowledgeWriteAction") === null && /creates a record/.test(error.message) ? "confirm_needed" : "cannot_enable"}`);
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=${enabled ? "enabled" : "paused"}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function deleteRuleAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/automation`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("ruleId"));
    if (!id) return;
    try {
      await AutomationRuleService.remove(actor, id);
    } catch (error) {
      if (error instanceof RuleNotFoundError) return;
      throw error;
    }
    revalidatePath(back);
    redirect(`${back}?notice=deleted`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function setAllPausedAction(orgSlug: string, formData: FormData): Promise<void> {
  const back = `/${orgSlug}/settings/automation`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const paused = formData.get("paused") === "true";
    await AutomationRuleService.setAllPaused(actor, paused);
    revalidatePath(back);
    redirect(`${back}?notice=${paused ? "all_paused" : "all_resumed"}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

/** "Run automations now": one bounded evaluation pass for this organization. */
export async function runNowAction(orgSlug: string): Promise<void> {
  const back = `/${orgSlug}/settings/automation`;
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const result = await AutomationEngine.runNow(actor);
    revalidatePath(back);
    const notice = result.skipped ? `run_${result.skipped}` : `ran&ok=${result.succeeded}&failed=${result.failed}&skipped=${result.skippedRuns}${result.capped ? "&more=1" : ""}`;
    redirect(`${back}?notice=${notice}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
