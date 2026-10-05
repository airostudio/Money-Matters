"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ForecastSettingsService } from "@/domain/forecasting/forecast-settings-service";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import { scenarioParamsFromForm } from "@/domain/forecasting/scenario-form";
import { SCENARIO_PARAM_SCHEMAS, type ScenarioType } from "@/domain/forecasting/scenario-parameters";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}error=${encodeURIComponent(message)}`);
}

function assertScenarioType(value: string): ScenarioType {
  if (!(value in SCENARIO_PARAM_SCHEMAS)) throw new Error("Unknown scenario type.");
  return value as ScenarioType;
}

export async function saveLowCashThresholdAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const returnPath = `/${orgSlug}/forecasting/cash-flow`;
  const horizon = String(formData.get("horizon") ?? "90D");
  try {
    await ForecastSettingsService.setLowCashThreshold(actor, String(formData.get("lowCashThreshold") ?? ""));
  } catch (error) {
    redirectWithError(`${returnPath}?horizon=${encodeURIComponent(horizon)}`, error);
  }
  revalidatePath(returnPath);
  redirect(`${returnPath}?horizon=${encodeURIComponent(horizon)}`);
}

export async function createScenarioAction(orgSlug: string, typeParam: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const newPath = `/${orgSlug}/forecasting/scenarios/new?type=${encodeURIComponent(typeParam)}`;

  let created;
  try {
    const type = assertScenarioType(typeParam);
    created = await ScenarioService.create(actor, {
      name: String(formData.get("name") ?? ""),
      type,
      parameters: scenarioParamsFromForm(type, formData),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (error) {
    redirectWithError(newPath, error);
  }

  revalidatePath(`/${orgSlug}/forecasting/scenarios`);
  redirect(`/${orgSlug}/forecasting/scenarios/${created.id}`);
}

export async function updateScenarioAction(orgSlug: string, scenarioId: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const editPath = `/${orgSlug}/forecasting/scenarios/${scenarioId}/edit`;
  try {
    const existing = await ScenarioService.get(actor, scenarioId);
    if (!existing) throw new Error("That scenario no longer exists.");
    await ScenarioService.update(actor, scenarioId, {
      name: String(formData.get("name") ?? ""),
      parameters: scenarioParamsFromForm(existing.type, formData),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (error) {
    redirectWithError(editPath, error);
  }
  revalidatePath(`/${orgSlug}/forecasting/scenarios`);
  redirect(`/${orgSlug}/forecasting/scenarios/${scenarioId}`);
}

export async function deleteScenarioAction(orgSlug: string, scenarioId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  try {
    await ScenarioService.delete(actor, scenarioId);
  } catch (error) {
    redirectWithError(`/${orgSlug}/forecasting/scenarios/${scenarioId}`, error);
  }
  revalidatePath(`/${orgSlug}/forecasting/scenarios`);
  redirect(`/${orgSlug}/forecasting/scenarios`);
}
