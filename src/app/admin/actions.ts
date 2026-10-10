"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import {
  CannotSuspendSelfError,
  InvalidPlanTierError,
  InvalidSeatLimitError,
  PlatformAdminService,
  SeatLimitBelowUsageError,
  TargetUserNotFoundError,
} from "@/domain/platform-admin/platform-admin-service";
import {
  InvalidRoleError,
  LastOwnerError,
  MembershipNotFoundError,
  OrganizationRecordNotFoundError,
} from "@/domain/organizations/membership-rules";

/**
 * Every action here calls `requirePlatformAdmin()` FIRST — server actions are
 * directly invocable, so the admin layout alone is not a gate — and the
 * service it then calls re-verifies the admin against the database again.
 * Non-admins get notFound() (404), never an error that reveals the section.
 *
 * Plain `<form action>`s can't render a returned error, so expected domain
 * refusals redirect back with `?error=` and successes with `?ok=`.
 */

const EXPECTED_ERRORS = [
  CannotSuspendSelfError,
  InvalidPlanTierError,
  InvalidRoleError,
  InvalidSeatLimitError,
  LastOwnerError,
  MembershipNotFoundError,
  OrganizationRecordNotFoundError,
  SeatLimitBelowUsageError,
  TargetUserNotFoundError,
];

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Only ever redirect back to an /admin page — never an open redirect. */
function returnPath(formData: FormData, fallback: string): string {
  const value = field(formData, "returnTo");
  return value.startsWith("/admin") && !value.startsWith("//") && !value.includes("\\") ? value.split("?")[0]! : fallback;
}

function done(path: string, kind: "ok" | "error", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

async function run(formData: FormData, fallback: string, successMessage: string, work: (adminUserId: string) => Promise<string | void>) {
  const admin = await requirePlatformAdmin();
  const path = returnPath(formData, fallback);
  let outcome: string;
  try {
    outcome = (await work(admin.userId)) ?? successMessage;
  } catch (error) {
    if (EXPECTED_ERRORS.some((E) => error instanceof E)) done(path, "error", (error as Error).message);
    throw error;
  }
  revalidatePath("/admin", "layout");
  done(path, "ok", outcome);
}

export async function updateOrganizationPlanAction(formData: FormData): Promise<void> {
  const organizationId = field(formData, "organizationId");
  await run(formData, `/admin/organizations/${encodeURIComponent(organizationId)}`, "Plan updated.", async (adminUserId) => {
    const result = await PlatformAdminService.setOrganizationPlan(adminUserId, organizationId, {
      seatLimit: Number(field(formData, "seatLimit")),
      planTier: field(formData, "planTier"),
    });
    return result.changed ? "Seat limit and plan saved." : "No change — values were already set.";
  });
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  const organizationId = field(formData, "organizationId");
  await run(formData, `/admin/organizations/${encodeURIComponent(organizationId)}`, "Role updated.", async (adminUserId) => {
    const result = await PlatformAdminService.changeMemberRole(
      adminUserId,
      organizationId,
      field(formData, "membershipId"),
      field(formData, "role"),
    );
    return result.changed ? "Role changed." : "No change — the member already has that role.";
  });
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const organizationId = field(formData, "organizationId");
  await run(formData, `/admin/organizations/${encodeURIComponent(organizationId)}`, "Member removed — their seat is free.", async (adminUserId) => {
    await PlatformAdminService.removeMember(adminUserId, organizationId, field(formData, "membershipId"));
  });
}

export async function suspendUserAction(formData: FormData): Promise<void> {
  const userId = field(formData, "userId");
  await run(formData, `/admin/users/${encodeURIComponent(userId)}`, "User suspended — their sessions stop working on their next request.", async (adminUserId) => {
    const result = await PlatformAdminService.setUserSuspended(adminUserId, userId, true);
    if (!result.changed) return "No change — the user was already suspended.";
  });
}

export async function reactivateUserAction(formData: FormData): Promise<void> {
  const userId = field(formData, "userId");
  await run(formData, `/admin/users/${encodeURIComponent(userId)}`, "User reactivated — they can sign in again.", async (adminUserId) => {
    const result = await PlatformAdminService.setUserSuspended(adminUserId, userId, false);
    if (!result.changed) return "No change — the user was not suspended.";
  });
}
