"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { membershipRoleEnum } from "@/db/schema";

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
