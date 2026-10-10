import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { ExportService, type DirectoryExportKind } from "@/domain/platform-admin/export-service";
import type { SeatFilter } from "@/domain/platform-admin/directory-service";

export const dynamic = "force-dynamic";

/** CSV export of directory data (users / organizations) only — never tenant financials. Admin-gated and itself audited. */
export async function GET(request: NextRequest, { params }: { params: { kind: string } }) {
  const admin = await requirePlatformAdmin();
  if (params.kind !== "users" && params.kind !== "organizations") notFound();
  const kind: DirectoryExportKind = params.kind;

  const q = request.nextUrl.searchParams.get("q")?.slice(0, 100) ?? undefined;
  const seatsParam = request.nextUrl.searchParams.get("seats");
  const seats: SeatFilter = seatsParam === "full" ? "full" : seatsParam === "over" ? "over" : "all";

  const statusParam = request.nextUrl.searchParams.get("status");
  const status = statusParam === "archived" ? "archived" : statusParam === "active" ? "active" : "all";
  const csv = await ExportService.exportDirectory(admin.userId, kind, { q, seats, status });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-directory.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
