"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { TaxCodeService } from "@/domain/tax/tax-code-service";

const CreateTaxCodeSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  ratePercent: z.coerce.number().min(0).max(100),
  jurisdiction: z.string().trim().min(1).max(10),
});

export async function createTaxCodeAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const parsed = CreateTaxCodeSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    ratePercent: formData.get("ratePercent"),
    jurisdiction: formData.get("jurisdiction"),
  });
  if (!parsed.success) return;

  await TaxCodeService.create(actor, {
    code: parsed.data.code,
    name: parsed.data.name,
    rate: (parsed.data.ratePercent / 100).toFixed(4),
    jurisdiction: parsed.data.jurisdiction.toUpperCase(),
    effectiveFrom: new Date("2000-01-01"),
  });

  revalidatePath(`/${orgSlug}/accounting/tax-codes`);
  redirect(`/${orgSlug}/accounting/tax-codes`);
}
