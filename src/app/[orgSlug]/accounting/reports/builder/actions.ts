"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { ReportBuilderConfigSchema, ReportBuilderService } from "@/domain/reporting/report-builder-service";

const SaveReportFormSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(["PERSONAL", "ORGANIZATION"]),
  config: z.string().min(1),
});

export async function saveReportAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);

    const parsed = SaveReportFormSchema.safeParse({
      id: formData.get("id") || undefined,
      name: formData.get("name"),
      description: formData.get("description") || undefined,
      visibility: formData.get("visibility"),
      config: formData.get("config"),
    });
    if (!parsed.success) {
      redirect(`/${orgSlug}/accounting/reports/builder?error=${encodeURIComponent("Could not save: invalid input.")}`);
    }

    let config;
    try {
      config = ReportBuilderConfigSchema.parse(JSON.parse(parsed.data.config));
    } catch {
      redirect(`/${orgSlug}/accounting/reports/builder?error=${encodeURIComponent("Could not save: invalid report configuration.")}`);
    }

    const saved = await ReportBuilderService.saveReport(actor, {
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      visibility: parsed.data.visibility,
      config,
    });

    revalidatePath(`/${orgSlug}/accounting/reports/builder`);
    redirect(`/${orgSlug}/accounting/reports/builder?saved=${saved.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function deleteSavedReportAction(orgSlug: string, id: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    await ReportBuilderService.deleteSavedReport(actor, id);
    revalidatePath(`/${orgSlug}/accounting/reports/builder`);
    redirect(`/${orgSlug}/accounting/reports/builder`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
