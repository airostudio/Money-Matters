"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { membershipRoleEnum } from "@/db/schema";
import { AutonomySettingsService, InvalidAutonomyLevelError } from "@/domain/ai-controller/autonomy";

const roleValues = membershipRoleEnum.enumValues;

const InviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(roleValues as [string, ...string[]]),
});

export async function inviteMemberAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const parsed = InviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return;

  await OrganizationService.addMemberByEmail(
    actor,
    parsed.data.email,
    parsed.data.role as (typeof roleValues)[number],
  );
  revalidatePath(`/${orgSlug}/settings`);
}

export async function updateMemberRoleAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const membershipId = formData.get("membershipId");
  const role = formData.get("role");
  if (typeof membershipId !== "string" || typeof role !== "string") return;
  if (!roleValues.includes(role as (typeof roleValues)[number])) return;

  await OrganizationService.updateMemberRole(actor, membershipId, role as (typeof roleValues)[number]);
  revalidatePath(`/${orgSlug}/settings`);
}

export async function removeMemberAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);

  const membershipId = formData.get("membershipId");
  if (typeof membershipId !== "string") return;

  await OrganizationService.removeMember(actor, membershipId);
  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * Master spec §8's autonomy level — OWNER/ADMINISTRATOR only
 * (`AutonomySettingsService.setLevel` itself enforces `organization:manage`,
 * this is just the form entry point). Levels 3/4 are rejected with an
 * honest reason rather than silently accepted — see
 * `src/domain/ai-controller/autonomy.ts`. A plain `<form action>` (like
 * every other setting on this page) can't render a returned error, so an
 * invalid submission (which the UI's own radio buttons never produce) is
 * simply ignored rather than thrown as an uncaught 500 — `InvalidAutonomyLevelError`
 * and a permission refusal are both swallowed here for that reason.
 */
export async function updateAutonomyLevelAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const raw = formData.get("autonomyLevel");
  const level = Number(raw);
  if (!Number.isInteger(level)) return;

  try {
    await AutonomySettingsService.setLevel(actor, level);
  } catch (err) {
    if (err instanceof InvalidAutonomyLevelError) return;
    throw err;
  }
  revalidatePath(`/${orgSlug}/settings`);
}
