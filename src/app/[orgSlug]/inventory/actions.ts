"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ProductService } from "@/domain/inventory/product-service";
import { InventoryAdjustmentService } from "@/domain/inventory/inventory-adjustment-service";
import type { ProductType } from "@/domain/inventory/types";

function redirectWithError(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createProductAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const type = String(formData.get("type") ?? "TRACKED_INVENTORY") as ProductType;

    let created;
    try {
      created = await ProductService.create(actor, {
        sku: String(formData.get("sku") ?? "").trim(),
        name: String(formData.get("name") ?? "").trim(),
        description: (String(formData.get("description") ?? "").trim() || undefined) as string | undefined,
        type,
        sellPrice: (String(formData.get("sellPrice") ?? "").trim() || undefined) as string | undefined,
        revenueAccountId: String(formData.get("revenueAccountId") ?? ""),
        purchaseAccountId: (String(formData.get("purchaseAccountId") ?? "").trim() || undefined) as string | undefined,
        inventoryAssetAccountId: (String(formData.get("inventoryAssetAccountId") ?? "").trim() || undefined) as
          | string
          | undefined,
        cogsAccountId: (String(formData.get("cogsAccountId") ?? "").trim() || undefined) as string | undefined,
        reorderPoint: (String(formData.get("reorderPoint") ?? "").trim() || undefined) as string | undefined,
        reorderQuantity: (String(formData.get("reorderQuantity") ?? "").trim() || undefined) as string | undefined,
        preferredSupplierContactId: (String(formData.get("preferredSupplierContactId") ?? "").trim() || undefined) as
          | string
          | undefined,
      });
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      redirectWithError(`/${orgSlug}/inventory/new`, error);
    }

    revalidatePath(`/${orgSlug}/inventory`);
    redirect(`/${orgSlug}/inventory/${created.id}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function setProductActiveAction(orgSlug: string, productId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/inventory/${productId}`;
    const isActive = String(formData.get("isActive") ?? "true") === "true";
    try {
      await ProductService.setActive(actor, productId, isActive);
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/inventory`);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function createAdjustmentAction(orgSlug: string, productId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const returnPath = `/${orgSlug}/inventory/${productId}`;
    try {
      await InventoryAdjustmentService.create(actor, {
        productId,
        quantityDelta: String(formData.get("quantityDelta") ?? "0"),
        unitCost: (String(formData.get("unitCost") ?? "").trim() || undefined) as string | undefined,
        reason: String(formData.get("reason") ?? ""),
        adjustmentAccountId: String(formData.get("adjustmentAccountId") ?? ""),
      });
    } catch (error) {
      redirectWithError(returnPath, error);
    }
    revalidatePath(returnPath);
    revalidatePath(`/${orgSlug}/inventory/valuation`);
    revalidatePath(`/${orgSlug}/inventory/reorder`);
    redirect(returnPath);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
