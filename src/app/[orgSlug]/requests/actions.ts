"use server";

import { rethrowPermissionDenied } from "@/lib/action-errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ClientRequestService } from "@/domain/client-requests/client-request-service";

/** The CLIENT replies to a request from its accountant (text and, optionally, one document). */
export async function replyAction(orgSlug: string, requestId: string, formData: FormData): Promise<void> {
  try {
    const { actor } = await requireOrgAndActor(orgSlug);
    const path = `/${orgSlug}/requests/${requestId}`;
    try {
      const file = formData.get("file");
      await ClientRequestService.reply(actor, requestId, {
        body: String(formData.get("body") ?? ""),
        side: "CLIENT",
        attachment:
          file instanceof File && file.size > 0
            ? { fileName: file.name, mimeType: file.type || "application/octet-stream", data: Buffer.from(await file.arrayBuffer()) }
            : undefined,
      });
    } catch (error) {
      redirect(`${path}?error=${encodeURIComponent(error instanceof Error ? error.message.slice(0, 500) : "Could not send the reply.")}`);
    }
    revalidatePath(path);
    revalidatePath(`/${orgSlug}/requests`);
    redirect(path);
  } catch (error) {
    return rethrowPermissionDenied(error, orgSlug);
  }
}
