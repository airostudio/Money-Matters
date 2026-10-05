import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { PRACTICE_COOKIE } from "../../../../require-practice";
import { PracticeService } from "@/domain/practice/practice-service";
import { WorkpaperService } from "@/domain/practice/workpaper-service";

/** Workpaper evidence, downloaded by an ACTIVE member of the practice that owns it (the database refuses anyone else). */
export async function GET(_req: Request, { params }: { params: { workpaperId: string; evidenceId: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  const actor = { userId: user.id };
  const mine = await PracticeService.listMine(actor);
  const chosen = cookies().get(PRACTICE_COOKIE)?.value;
  const practice = mine.find((p) => p.id === chosen) ?? mine[0];
  if (!practice) return new NextResponse("Not found", { status: 404 });
  try {
    const file = await WorkpaperService.getEvidenceFile(actor, practice.id, params.evidenceId);
    if (!file) return new NextResponse("Not found", { status: 404 });
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
