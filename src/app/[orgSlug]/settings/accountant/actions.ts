"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PracticeConsentService } from "@/domain/practice/consent-service";

async function respond(orgSlug: string, op: "accept" | "decline" | "revoke", consentId: string): Promise<void> {
  const { actor } = await requireOrgAndActor(orgSlug);
  const path = `/${orgSlug}/settings/accountant`;
  try {
    // PracticeConsentService itself requires organization:manage (OWNER / ADMINISTRATOR) — the page hides the buttons, the service enforces it.
    await PracticeConsentService[op](actor, consentId);
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(error instanceof Error ? error.message.slice(0, 500) : "That did not work.")}`);
  }
  revalidatePath(path);
  redirect(path);
}

export async function acceptAction(orgSlug: string, consentId: string): Promise<void> {
  await respond(orgSlug, "accept", consentId);
}
export async function declineAction(orgSlug: string, consentId: string): Promise<void> {
  await respond(orgSlug, "decline", consentId);
}
export async function revokeAction(orgSlug: string, consentId: string): Promise<void> {
  await respond(orgSlug, "revoke", consentId);
}
