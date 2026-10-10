"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/session";
import { OAuthGrantNotFoundError } from "@/domain/oauth/errors";
import { OAuthGrantService } from "@/domain/oauth/grant-service";

/**
 * Withdraws the signed-in person's OWN consent for one app in one organization. `requireActor` resolves their real
 * membership (an archived organization or a non-member is refused), and the service only ever lets a person revoke a grant
 * that is theirs here (an Owner / Administrator revokes other people's from Settings > Connected apps). Immediate: the next
 * API request with any of that grant's tokens fails.
 */
export async function revokeOwnGrantAction(formData: FormData): Promise<void> {
  const organizationId = formData.get("organizationId");
  const grantId = formData.get("grantId");
  if (typeof organizationId !== "string" || typeof grantId !== "string") return;
  const actor = await requireActor(organizationId);
  try {
    await OAuthGrantService.revoke(actor, grantId);
  } catch (error) {
    if (!(error instanceof OAuthGrantNotFoundError)) throw error;
  }
  revalidatePath("/app/authorised-apps");
  redirect("/app/authorised-apps");
}
