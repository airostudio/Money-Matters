"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { accountTypeEnum } from "@/db/schema";

const accountTypes = accountTypeEnum.enumValues;

const CreateAccountSchema = z.object({
  code: z.string().trim().min(1, "Account code is required").max(20),
  name: z.string().trim().min(1, "Account name is required").max(200),
  type: z.enum(accountTypes as [string, ...string[]]),
  subType: z.string().trim().max(100).optional(),
});

export async function createAccountAction(orgSlug: string, formData: FormData): Promise<void> {
  const { actor, org } = await requireOrgAndActor(orgSlug);

  const parsed = CreateAccountSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    type: formData.get("type"),
    subType: formData.get("subType") || undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input.";
    redirect(`/${orgSlug}/accounting/chart-of-accounts/new?error=${encodeURIComponent(message)}`);
  }

  try {
    await AccountService.create(actor, {
      code: parsed.data.code,
      name: parsed.data.name,
      type: parsed.data.type as (typeof accountTypes)[number],
      subType: parsed.data.subType,
      currency: org.baseCurrency,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create account.";
    redirect(`/${orgSlug}/accounting/chart-of-accounts/new?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/${orgSlug}/accounting/chart-of-accounts`);
  redirect(`/${orgSlug}/accounting/chart-of-accounts`);
}

export async function setAccountActiveAction(
  orgSlug: string,
  accountId: string,
  isActive: boolean,
): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  await AccountService.setActive(actor, accountId, isActive);
  revalidatePath(`/${orgSlug}/accounting/chart-of-accounts`);
}
