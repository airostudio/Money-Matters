"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { DimensionService } from "@/domain/dimensions/dimension-service";

const NameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const LabelSchema = z.object({ dimensionId: z.string().uuid(), label: z.string().trim().min(1).max(100) });

export async function createDimensionAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const parsed = NameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return;
  await DimensionService.createDimension(actor, { name: parsed.data.name });
  revalidatePath(`/${orgSlug}/accounting/dimensions`);
}

export async function addDimensionValueAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const parsed = LabelSchema.safeParse({ dimensionId: formData.get("dimensionId"), label: formData.get("label") });
  if (!parsed.success) return;
  await DimensionService.addValue(actor, parsed.data.dimensionId, { label: parsed.data.label });
  revalidatePath(`/${orgSlug}/accounting/dimensions`);
}

export async function setDimensionActiveAction(orgSlug: string, dimensionId: string, isActive: boolean): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await DimensionService.setDimensionActive(actor, dimensionId, isActive);
  revalidatePath(`/${orgSlug}/accounting/dimensions`);
}

export async function setDimensionValueActiveAction(
  orgSlug: string,
  dimensionValueId: string,
  isActive: boolean,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await DimensionService.setValueActive(actor, dimensionValueId, isActive);
  revalidatePath(`/${orgSlug}/accounting/dimensions`);
}
