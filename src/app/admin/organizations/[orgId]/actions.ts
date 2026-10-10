"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { PlatformAdminService } from "@/domain/platform-admin/platform-admin-service";
import {
  InvalidArchiveReasonError,
  OrganizationAlreadyArchivedError,
  OrganizationNotArchivedError,
  OrganizationNotFoundForArchiveError,
} from "@/domain/organizations/membership-rules";

/**
 * Archive / restore an organization (docs/security.md section 17). Same discipline as ../../actions.ts: every action
 * calls `requirePlatformAdmin()` FIRST (a non-admin gets a 404, never an error that reveals the section), and the
 * service re-verifies the admin against the database. Kept in its own module so the existing "every exported admin
 * action rejects a non-admin" enumeration stays exactly as reviewed; src/tests/integration/organizations/admin-archive-actions.test.ts
 * proves the same property for these two.
 */

const EXPECTED_ERRORS = [InvalidArchiveReasonError, OrganizationAlreadyArchivedError, OrganizationNotArchivedError, OrganizationNotFoundForArchiveError];

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function back(organizationId: string, kind: "ok" | "error", message: string): never {
  redirect(`/admin/organizations/${encodeURIComponent(organizationId)}?${kind}=${encodeURIComponent(message)}`);
}

export async function archiveOrganizationAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const organizationId = field(formData, "organizationId");
  try {
    await PlatformAdminService.archiveOrganization(admin.userId, organizationId, field(formData, "reason"));
  } catch (error) {
    if (EXPECTED_ERRORS.some((E) => error instanceof E)) back(organizationId, "error", (error as Error).message);
    throw error;
  }
  revalidatePath("/admin", "layout");
  back(organizationId, "ok", "Organization archived - nobody can access it until it is restored. Nothing was deleted.");
}

export async function restoreOrganizationAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const organizationId = field(formData, "organizationId");
  try {
    await PlatformAdminService.restoreOrganization(admin.userId, organizationId);
  } catch (error) {
    if (EXPECTED_ERRORS.some((E) => error instanceof E)) back(organizationId, "error", (error as Error).message);
    throw error;
  }
  revalidatePath("/admin", "layout");
  back(organizationId, "ok", "Organization restored exactly as it was.");
}
