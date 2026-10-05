"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { FixedAssetClassService } from "@/domain/fixed-assets/asset-class-service";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { DepreciationService } from "@/domain/fixed-assets/depreciation-service";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function optionalString(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? "").trim();
  return value || undefined;
}

function optionalInt(formData: FormData, key: string): number | undefined {
  const value = String(formData.get(key) ?? "").trim();
  return value ? Number(value) : undefined;
}

// ---------------------------------------------------------------------------
// Asset classes
// ---------------------------------------------------------------------------

export async function createAssetClassAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/fixed-assets/classes`;
    try {
      await FixedAssetClassService.create(actor, {
        name: String(formData.get("name") ?? "").trim(),
        defaultUsefulLifeMonths: Number(formData.get("defaultUsefulLifeMonths") ?? "0"),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerAssetAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const source = String(formData.get("source") ?? "standalone");

    let created;
    try {
      if (source === "bill_line") {
        created = await FixedAssetService.registerFromBillLine(actor, {
          billLineId: String(formData.get("billLineId") ?? ""),
          assetClassId: String(formData.get("assetClassId") ?? ""),
          name: String(formData.get("name") ?? "").trim(),
          description: optionalString(formData, "description"),
          usefulLifeMonths: optionalInt(formData, "usefulLifeMonths"),
          residualValue: optionalString(formData, "residualValue"),
          assetAccountId: String(formData.get("assetAccountId") ?? ""),
          accumulatedDepreciationAccountId: String(formData.get("accumulatedDepreciationAccountId") ?? ""),
          depreciationExpenseAccountId: String(formData.get("depreciationExpenseAccountId") ?? ""),
          locationReference: optionalString(formData, "locationReference"),
          serialNumber: optionalString(formData, "serialNumber"),
        });
      } else {
        const acquisitionDateRaw = String(formData.get("acquisitionDate") ?? "");
        created = await FixedAssetService.registerAsset(actor, {
          assetClassId: String(formData.get("assetClassId") ?? ""),
          name: String(formData.get("name") ?? "").trim(),
          description: optionalString(formData, "description"),
          acquisitionDate: acquisitionDateRaw ? new Date(acquisitionDateRaw) : new Date(),
          acquisitionCost: String(formData.get("acquisitionCost") ?? ""),
          usefulLifeMonths: optionalInt(formData, "usefulLifeMonths"),
          residualValue: optionalString(formData, "residualValue"),
          assetAccountId: String(formData.get("assetAccountId") ?? ""),
          accumulatedDepreciationAccountId: String(formData.get("accumulatedDepreciationAccountId") ?? ""),
          depreciationExpenseAccountId: String(formData.get("depreciationExpenseAccountId") ?? ""),
          locationReference: optionalString(formData, "locationReference"),
          serialNumber: optionalString(formData, "serialNumber"),
        });
      }
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      redirectWithError(`/${orgSlug}/fixed-assets/new`, error);
    }

    revalidatePath(`/${orgSlug}/fixed-assets`);
    redirect(`/${orgSlug}/fixed-assets/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function updateAssetDetailsAction(orgSlug: string, assetId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/fixed-assets/${assetId}`;
    try {
      await FixedAssetService.updateDetails(actor, assetId, {
        name: String(formData.get("name") ?? "").trim(),
        description: optionalString(formData, "description"),
        locationReference: optionalString(formData, "locationReference"),
        serialNumber: optionalString(formData, "serialNumber"),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/fixed-assets`);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

// ---------------------------------------------------------------------------
// Disposal / write-off
// ---------------------------------------------------------------------------

export async function disposeAssetAction(orgSlug: string, assetId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/fixed-assets/${assetId}`;
    try {
      await FixedAssetService.disposeAsset(actor, assetId, {
        disposalDate: new Date(String(formData.get("disposalDate") ?? "")),
        proceeds: String(formData.get("proceeds") ?? "0"),
        proceedsAccountId: String(formData.get("proceedsAccountId") ?? ""),
        gainLossAccountId: String(formData.get("gainLossAccountId") ?? ""),
        memo: optionalString(formData, "memo"),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/fixed-assets`);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function writeOffAssetAction(orgSlug: string, assetId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/fixed-assets/${assetId}`;
    try {
      await FixedAssetService.writeOffAsset(actor, assetId, {
        disposalDate: new Date(String(formData.get("disposalDate") ?? "")),
        lossAccountId: String(formData.get("lossAccountId") ?? ""),
        memo: optionalString(formData, "memo"),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/fixed-assets`);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export async function runDepreciationAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/fixed-assets/depreciation`;
    const periodMonthRaw = String(formData.get("periodMonth") ?? "");

    let result;
    try {
      result = await DepreciationService.runForPeriod(actor, {
        periodMonth: periodMonthRaw ? new Date(`${periodMonthRaw}-01`) : new Date(),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }

    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/fixed-assets`);
    redirect(`${returnPath}?ran=${result.periodStart}&posted=${result.totalPosted}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
