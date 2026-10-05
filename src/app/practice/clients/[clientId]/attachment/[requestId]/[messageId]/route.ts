import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { PRACTICE_COOKIE } from "../../../../../require-practice";
import { PracticeRequestService } from "@/domain/practice/practice-request-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { cookies } from "next/headers";

/** A client's attachment on a request, downloaded by the practice staff member who is a member of that client. */
export async function GET(_req: Request, { params }: { params: { clientId: string; requestId: string; messageId: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  const actor = { userId: user.id };
  const mine = await PracticeService.listMine(actor);
  const chosen = cookies().get(PRACTICE_COOKIE)?.value;
  const practice = mine.find((p) => p.id === chosen) ?? mine[0];
  if (!practice) return new NextResponse("Not found", { status: 404 });
  try {
    const file = await PracticeRequestService.getAttachment(actor, practice.id, params.clientId, params.requestId, params.messageId);
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
