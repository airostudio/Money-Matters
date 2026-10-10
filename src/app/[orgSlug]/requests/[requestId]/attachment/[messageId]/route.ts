import { NextResponse } from "next/server";
import { getActorForOrganization } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { ClientRequestService } from "@/domain/client-requests/client-request-service";

/** A request attachment, for a member of the organization whose role can read requests. */
export async function GET(_req: Request, { params }: { params: { orgSlug: string; requestId: string; messageId: string } }) {
  const org = await OrganizationService.getBySlug(params.orgSlug);
  if (!org) return new NextResponse("Not found", { status: 404 });
  const actor = await getActorForOrganization(org.id);
  if (!actor) return new NextResponse("Not found", { status: 404 });
  try {
    const file = await ClientRequestService.getAttachment(actor, params.requestId, params.messageId);
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, "_")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
