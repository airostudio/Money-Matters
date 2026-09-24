import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { balanceSheetToCsv } from "@/domain/reporting/csv-export";
import { parseDateParam } from "@/domain/reporting/period-presets";

export async function GET(request: Request, { params }: { params: { orgSlug: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const url = new URL(request.url);

  const asOf = parseDateParam(url.searchParams.get("asOf") ?? undefined) ?? new Date();
  const compareAsOf = parseDateParam(url.searchParams.get("compareAsOf") ?? undefined);

  const report = await ReportingService.getBalanceSheet(actor, asOf, compareAsOf);
  const csv = balanceSheetToCsv(report);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="balance-sheet-${url.searchParams.get("asOf") ?? ""}.csv"`,
    },
  });
}
