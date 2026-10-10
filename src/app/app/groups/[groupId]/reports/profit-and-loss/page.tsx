import Link from "next/link";
import { requireGroupUser } from "../../../require-user";
import { runConsolidatedReport } from "../../../report-helpers";
import { ConsolidationService } from "@/domain/consolidation/consolidation-service";
import { currentMonthRange, formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Button } from "@/components/ui/button";
import {
  ConsolidatedTable,
  EliminationDetails,
  ExclusionBanner,
  UnmappedNotice,
} from "@/components/consolidation/consolidated-table";

export default async function ConsolidatedProfitAndLossPage({
  params,
  searchParams,
}: {
  params: { groupId: string };
  searchParams: { from?: string; to?: string };
}) {
  const { actor } = await requireGroupUser();
  const fallback = currentMonthRange();
  const from = parseDateParam(searchParams.from) ?? fallback.from;
  const to = parseDateParam(searchParams.to) ?? fallback.to;
  const fromParam = formatDateParam(from);
  const toParam = formatDateParam(to);
  const { report, error } = await runConsolidatedReport(() => ConsolidationService.profitAndLoss(actor, params.groupId, { from, to }));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/app/groups" className="hover:underline">
            Entity groups
          </Link>{" "}
          /{" "}
          <Link href={`/app/groups/${params.groupId}`} className="hover:underline">
            {report?.group.name ?? "Group"}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Consolidated Profit &amp; Loss</h1>
        <p className="text-sm text-muted-foreground">
          {fromParam} to {toParam}. Computed live from each entity&apos;s own Profit &amp; Loss; nothing is stored or posted.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            From
          </label>
          <input type="date" id="from" name="from" defaultValue={fromParam} className="h-9 rounded-md border border-input bg-background px-3 text-sm" />
        </div>
        <div className="space-y-1">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            To
          </label>
          <input type="date" id="to" name="to" defaultValue={toParam} className="h-9 rounded-md border border-input bg-background px-3 text-sm" />
        </div>
        <Button type="submit" size="sm">
          Update
        </Button>
      </form>

      {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      {report && (
        <>
          <ExclusionBanner exclusions={report.exclusions} deselectedCount={report.deselectedCount} />
          <UnmappedNotice count={report.unmapped.count} groupId={params.groupId} />
          {report.entities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entities you can read are included in this group.</p>
          ) : (
            <>
              <ConsolidatedTable
                entities={report.entities}
                currency={report.currency}
                range={{ from: fromParam, to: toParam }}
                sections={[
                  { title: "Revenue", section: report.revenue, totalLabel: "Total Revenue" },
                  { title: "Expenses", section: report.expenses, totalLabel: "Total Expenses" },
                ]}
                extraTotals={[{ label: "Net Profit", totals: report.netProfit, strong: true }]}
              />
              <EliminationDetails
                entries={report.eliminationEntries}
                adjustments={report.adjustments}
                reconciliation={report.reconciliation}
                currency={report.currency}
                groupId={params.groupId}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
