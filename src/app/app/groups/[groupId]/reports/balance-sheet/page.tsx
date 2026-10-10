import Link from "next/link";
import { requireGroupUser } from "../../../require-user";
import { runConsolidatedReport } from "../../../report-helpers";
import { ConsolidationService } from "@/domain/consolidation/consolidation-service";
import { formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";
import {
  ConsolidatedTable,
  EliminationDetails,
  ExclusionBanner,
  UnmappedNotice,
} from "@/components/consolidation/consolidated-table";

export default async function ConsolidatedBalanceSheetPage({
  params,
  searchParams,
}: {
  params: { groupId: string };
  searchParams: { asOf?: string };
}) {
  const { actor } = await requireGroupUser();
  const asOf = parseDateParam(searchParams.asOf) ?? new Date();
  const asOfParam = formatDateParam(asOf);
  const { report, error } = await runConsolidatedReport(() => ConsolidationService.balanceSheet(actor, params.groupId, asOf));

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
        <h1 className="text-2xl font-semibold tracking-tight">Consolidated Balance Sheet</h1>
        <p className="text-sm text-muted-foreground">
          As of {asOf.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}. Computed live from each entity&apos;s own
          Balance Sheet; nothing is stored or posted.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="asOf" className="text-xs font-medium text-muted-foreground">
            As of
          </label>
          <input type="date" id="asOf" name="asOf" defaultValue={asOfParam} className="h-9 rounded-md border border-input bg-background px-3 text-sm" />
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
              <div
                className={`rounded-md border p-4 text-sm ${
                  report.isBalanced ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
                }`}
              >
                {report.isBalanced ? (
                  <>✓ Balanced — Assets = Liabilities + Equity in every entity column, combined, and after eliminations and adjustments.</>
                ) : (
                  <>
                    ✗ Out of balance — consolidated difference <MoneyDisplay amount={report.difference.consolidated} currency={report.currency} />. Check the
                    entity columns below for the one that does not balance.
                  </>
                )}
              </div>

              <ConsolidatedTable
                entities={report.entities}
                currency={report.currency}
                range={{ to: asOfParam }}
                sections={[
                  { title: "Assets", section: report.assets, totalLabel: "Total Assets" },
                  { title: "Liabilities", section: report.liabilities, totalLabel: "Total Liabilities" },
                  { title: "Equity", section: report.equity, totalLabel: "Total Equity" },
                ]}
                extraTotals={[
                  { label: "Total Liabilities + Equity", totals: report.totalLiabilitiesAndEquity, strong: true },
                  { label: "Difference (Assets − Liabilities − Equity)", totals: report.difference },
                ]}
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
