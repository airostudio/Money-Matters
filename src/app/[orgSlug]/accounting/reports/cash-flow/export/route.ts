import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { cashFlowToCsv } from "@/domain/reporting/csv-export";
import { currentMonthRange, parseDateParam } from "@/domain/reporting/period-presets";

export async function GET(request: Request, { params }: { params: { orgSlug: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const url = new URL(request.url);

  const defaultRange = currentMonthRange();
  const from = parseDateParam(url.searchParams.get("from") ?? undefined) ?? defaultRange.from;
  const to = parseDateParam(url.searchParams.get("to") ?? undefined) ?? defaultRange.to;

  const statement = await ReportingService.getCashFlowStatement(actor, { from, to });
  const csv = cashFlowToCsv(statement);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cash-flow-${url.searchParams.get("from") ?? ""}-to-${url.searchParams.get("to") ?? ""}.csv"`,
    },
  });
}
