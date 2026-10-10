import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { BasService } from "@/domain/tax/bas-service";
import { basReportToCsv } from "@/domain/tax/bas-csv";

export async function GET(_request: Request, { params }: { params: { orgSlug: string; basId: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  try {
    const view = await BasService.get(actor, params.basId);
    const csv = basReportToCsv(view.report, { status: view.statement.status, contentHash: view.statement.contentHash });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="bas-${view.report.periodStart}-to-${view.report.periodEnd}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return new NextResponse("Forbidden", { status: 403 });
    throw error;
  }
}
