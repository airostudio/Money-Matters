import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import {
  currentMonthRange,
  formatDateParam,
  parseDateParam,
  resolveComparisonRange,
  type ComparisonMode,
} from "@/domain/reporting/period-presets";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";
import type { ProfitAndLossLine } from "@/domain/reporting/financial-statements";

function VarianceCell({ variance, currency }: { variance?: string; currency: string }) {
  if (variance === undefined) return null;
  return (
    <td className="px-6 py-2.5 text-right text-muted-foreground">
      <MoneyDisplay amount={variance} currency={currency} showSign />
    </td>
  );
}

function LineRow({
  line,
  currency,
  orgSlug,
  hasComparison,
  from,
  to,
}: {
  line: ProfitAndLossLine;
  currency: string;
  orgSlug: string;
  hasComparison: boolean;
  from: string;
  to: string;
}) {
  return (
    <tr>
      <td className="px-6 py-2.5">
        <Link
          href={`/${orgSlug}/accounting/accounts/${line.accountId}/transactions?from=${from}&to=${to}`}
          className="text-primary hover:underline"
        >
          <span className="font-mono text-xs text-muted-foreground">{line.code}</span> {line.name}
        </Link>
      </td>
      <td className="px-6 py-2.5 text-right">
        <MoneyDisplay amount={line.amount} currency={currency} />
      </td>
      {hasComparison && (
        <td className="px-6 py-2.5 text-right text-muted-foreground">
          <MoneyDisplay amount={line.comparisonAmount ?? "0.0000"} currency={currency} />
        </td>
      )}
      {hasComparison && <VarianceCell variance={line.variance} currency={currency} />}
    </tr>
  );
}

export default async function ProfitAndLossPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { from?: string; to?: string; compare?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const defaultRange = currentMonthRange();
  const from = parseDateParam(searchParams.from) ?? defaultRange.from;
  const to = parseDateParam(searchParams.to) ?? defaultRange.to;
  const compareMode: ComparisonMode =
    searchParams.compare === "previous_year" || searchParams.compare === "none" ? searchParams.compare : "previous_period";
  const comparison = resolveComparisonRange({ from, to }, compareMode);

  const report = await ReportingService.getProfitAndLoss(actor, { from, to }, comparison);
  const hasComparison = comparison !== undefined;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profit &amp; Loss</h1>
          <p className="text-sm text-muted-foreground">
            {from.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })} –{" "}
            {to.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}
            {hasComparison && comparison && (
              <>
                {" "}
                vs.{" "}
                {comparison.from.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })} –{" "}
                {comparison.to.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })}
              </>
            )}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href={`/${org.slug}/accounting/reports/profit-and-loss/export?from=${formatDateParam(from)}&to=${formatDateParam(to)}&compare=${compareMode}`}
          >
            Export CSV
          </a>
        </Button>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            type="date"
            id="from"
            name="from"
            defaultValue={formatDateParam(from)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            type="date"
            id="to"
            name="to"
            defaultValue={formatDateParam(to)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="compare" className="text-xs font-medium text-muted-foreground">
            Compare to
          </label>
          <select
            id="compare"
            name="compare"
            defaultValue={compareMode}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="previous_period">Previous period</option>
            <option value="previous_year">Same period last year</option>
            <option value="none">No comparison</option>
          </select>
        </div>
        <Button type="submit" size="sm">
          Update
        </Button>
      </form>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Account</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
                {hasComparison && <th className="px-6 py-2 text-right font-medium">Comparison</th>}
                {hasComparison && <th className="px-6 py-2 text-right font-medium">Variance</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr className="bg-muted/40">
                <td colSpan={hasComparison ? 4 : 2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Revenue
                </td>
              </tr>
              {report.revenue.length === 0 ? (
                <tr>
                  <td colSpan={hasComparison ? 4 : 2} className="px-6 py-4 text-center text-muted-foreground">
                    No revenue in this period.
                  </td>
                </tr>
              ) : (
                report.revenue.map((line) => (
                  <LineRow key={line.accountId} line={line} currency={org.baseCurrency} orgSlug={org.slug} hasComparison={hasComparison} from={formatDateParam(from)} to={formatDateParam(to)} />
                ))
              )}
              <tr className="font-medium">
                <td className="px-6 py-2.5">Total Revenue</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={report.totalRevenue} currency={org.baseCurrency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalRevenueComparison ?? "0.0000"} currency={org.baseCurrency} />
                  </td>
                )}
                {hasComparison && <td className="px-6 py-2.5" />}
              </tr>

              <tr className="bg-muted/40">
                <td colSpan={hasComparison ? 4 : 2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Expenses
                </td>
              </tr>
              {report.expenses.length === 0 ? (
                <tr>
                  <td colSpan={hasComparison ? 4 : 2} className="px-6 py-4 text-center text-muted-foreground">
                    No expenses in this period.
                  </td>
                </tr>
              ) : (
                report.expenses.map((line) => (
                  <LineRow key={line.accountId} line={line} currency={org.baseCurrency} orgSlug={org.slug} hasComparison={hasComparison} from={formatDateParam(from)} to={formatDateParam(to)} />
                ))
              )}
              <tr className="font-medium">
                <td className="px-6 py-2.5">Total Expenses</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={report.totalExpenses} currency={org.baseCurrency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalExpensesComparison ?? "0.0000"} currency={org.baseCurrency} />
                  </td>
                )}
                {hasComparison && <td className="px-6 py-2.5" />}
              </tr>
            </tbody>
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td className="px-6 py-3">Net Profit</td>
                <td className="px-6 py-3 text-right">
                  <MoneyDisplay amount={report.netProfit} currency={org.baseCurrency} showSign />
                </td>
                {hasComparison && (
                  <td className="px-6 py-3 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.netProfitComparison ?? "0.0000"} currency={org.baseCurrency} showSign />
                  </td>
                )}
                {hasComparison && (
                  <td className="px-6 py-3 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.netProfitVariance ?? "0.0000"} currency={org.baseCurrency} showSign />
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
