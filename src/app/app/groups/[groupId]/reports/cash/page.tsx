import Link from "next/link";
import { requireGroupUser } from "../../../require-user";
import { runConsolidatedReport } from "../../../report-helpers";
import { ConsolidationService } from "@/domain/consolidation/consolidation-service";
import { formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { ExclusionBanner } from "@/components/consolidation/consolidated-table";

export default async function ConsolidatedCashPage({
  params,
  searchParams,
}: {
  params: { groupId: string };
  searchParams: { asOf?: string };
}) {
  const { actor } = await requireGroupUser();
  const asOf = parseDateParam(searchParams.asOf) ?? new Date();
  const asOfParam = formatDateParam(asOf);
  const { report, error } = await runConsolidatedReport(() => ConsolidationService.cash(actor, params.groupId, asOf));

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
        <h1 className="text-2xl font-semibold tracking-tight">Consolidated cash position</h1>
        <p className="text-sm text-muted-foreground">
          Bank balances (the ledger balance of each linked bank account) as of {asOfParam}. Cash is never eliminated.
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Total cash: <MoneyDisplay amount={report.total} currency={report.currency} />
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {report.entities.map((e) => (
                    <tr key={e.organizationId}>
                      <td className="px-6 py-2.5 align-top">
                        <Link href={`/${e.slug}/money`} className="font-medium text-primary hover:underline">
                          {e.name}
                        </Link>
                        <ul className="mt-1 text-xs text-muted-foreground">
                          {e.accounts.map((a) => (
                            <li key={a.bankAccountId}>
                              {a.name}
                              {a.institutionName ? ` — ${a.institutionName}` : ""}: <MoneyDisplay amount={a.balance} currency={report.currency} />
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="px-6 py-2.5 text-right align-top font-medium">
                        <MoneyDisplay amount={e.total} currency={report.currency} />
                      </td>
                    </tr>
                  ))}
                  {report.entities.length === 0 && (
                    <tr>
                      <td className="px-6 py-6 text-center text-muted-foreground">No entities you can read are included in this group.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
