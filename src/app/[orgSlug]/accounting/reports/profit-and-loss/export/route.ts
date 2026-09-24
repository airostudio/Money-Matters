import { NextResponse } from "next/server";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { profitAndLossToCsv } from "@/domain/reporting/csv-export";
import { currentMonthRange, parseDateParam, resolveComparisonRange, type ComparisonMode } from "@/domain/reporting/period-presets";

export async function GET(request: Request, { params }: { params: { orgSlug: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const url = new URL(request.url);

  const defaultRange = currentMonthRange();
  const from = parseDateParam(url.searchParams.get("from") ?? undefined) ?? defaultRange.from;
  const to = parseDateParam(url.searchParams.get("to") ?? undefined) ?? defaultRange.to;
  const compareParam = url.searchParams.get("compare");
  const compareMode: ComparisonMode =
    compareParam === "previous_year" || compareParam === "none" ? compareParam : "previous_period";
  const comparison = resolveComparisonRange({ from, to }, compareMode);

  const report = await ReportingService.getProfitAndLoss(actor, { from, to }, comparison);
  const csv = profitAndLossToCsv(report);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="profit-and-loss-${url.searchParams.get("from") ?? ""}-to-${url.searchParams.get("to") ?? ""}.csv"`,
    },
  });
}
