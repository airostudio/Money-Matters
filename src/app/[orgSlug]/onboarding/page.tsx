import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { createBankAccountAction } from "../money/actions";
import { OnboardingWizard } from "./onboarding-wizard";

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "onboarding:manage")) {
    redirect(`/${params.orgSlug}`);
  }

  const accounts = await AccountService.list(actor);
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const hasNonSystemAccounts = accounts.some((a) => !a.isSystemAccount);

  async function linkFirstBankAccountAction(formData: FormData): Promise<void> {
    "use server";
    await createBankAccountAction(
      params.orgSlug,
      formData,
      `/${params.orgSlug}/onboarding`,
      `/${params.orgSlug}?onboarded=1`,
    );
  }

  return (
    <OnboardingWizard
      orgSlug={params.orgSlug}
      organizationName={org.name}
      defaultCountry={org.country}
      defaultCurrency={org.baseCurrency}
      hasExistingChartOfAccounts={hasNonSystemAccounts}
      existingAssetAccounts={assetAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
      createBankAccountAction={linkFirstBankAccountAction}
      initialBankError={searchParams.error}
    />
  );
}
