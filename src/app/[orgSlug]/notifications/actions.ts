"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { NotificationService } from "@/domain/notifications/notification-service";
import { rethrowPermissionDenied } from "@/lib/action-errors";

/**
 * Server actions for the notifications page. A person can only ever act on their OWN notifications: the service filters on
 * the signed-in person as well as the organization, so a forged id for someone else's item changes nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: FormDataEntryValue | null): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

export async function markReadAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("notificationId"));
    if (id) await NotificationService.markRead(actor, id);
    revalidatePath(`/${orgSlug}/notifications`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function dismissAction(orgSlug: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const id = idOf(formData.get("notificationId"));
    if (id) await NotificationService.dismiss(actor, id);
    revalidatePath(`/${orgSlug}/notifications`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function markAllReadAction(orgSlug: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    await NotificationService.markAllRead(actor);
    revalidatePath(`/${orgSlug}/notifications`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}

export async function clearOldAction(orgSlug: string): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const removed = await NotificationService.purge(actor);
    revalidatePath(`/${orgSlug}/notifications`);
    redirect(`/${orgSlug}/notifications?cleared=${Math.min(removed, 9999)}`);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
