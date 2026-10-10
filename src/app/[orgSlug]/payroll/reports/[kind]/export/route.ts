import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { PAYROLL_REPORT_KINDS, payrollReportCsv, type PayrollReportKind } from "@/domain/payroll/payroll-report-csv";
import { fiscalYearRange } from "../../range";

export async function GET(request: Request, { params }: { params: { orgSlug: string; kind: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  if (!(PAYROLL_REPORT_KINDS as readonly string[]).includes(params.kind)) return new NextResponse("Not found", { status: 404 });
  const url = new URL(request.url);
  const range = fiscalYearRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  try {
    const csv = await payrollReportCsv(actor, params.kind as PayrollReportKind, range);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payroll-${params.kind}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return new NextResponse("Forbidden", { status: 403 });
    throw error;
  }
}
