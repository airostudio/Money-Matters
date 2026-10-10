import { requireOrgAndActor } from "@/lib/session";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { BudgetVarianceService } from "@/domain/budgeting/budget-variance-service";
import { currentMonthRange, formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function BudgetVsActualPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { budgetId?: string; from?: string; to?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const defaultRange = currentMonthRange();
  const from = parseDateParam(searchParams.from) ?? defaultRange.from;
  const to = parseDateParam(searchParams.to) ?? defaultRange.to;

  const budgets = await BudgetService.list(actor, { status: "ACTIVE" });
  const budgetId = searchParams.budgetId || budgets[0]?.id;

  const report = budgetId
    ? await BudgetVarianceService.getBudgetVsActual(actor, budgetId, { from, to }).catch(() => null)
    : null;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Budget vs. Actual</h1>
        <p className="text-sm text-muted-foreground">
          {from.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })} –{" "}
          {to.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      {budgets.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No ACTIVE budget exists yet.{" "}
            <Button asChild variant="link" size="sm" className="px-0">
              <a href={`/${org.slug}/budgets/new`}>Create one</a>
            </Button>
            , enter its monthly figures, then activate it to see this report.
          </CardContent>
        </Card>
      ) : (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="budgetId" className="text-xs font-medium text-muted-foreground">
              Budget
            </label>
            <select
              id="budgetId"
              name="budgetId"
              defaultValue={budgetId}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
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
          <Button type="submit" size="sm">
            Update
          </Button>
        </form>
      )}

      {report && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Account</th>
                  <th className="px-6 py-2 text-right font-medium">Budget</th>
                  <th className="px-6 py-2 text-right font-medium">Actual</th>
                  <th className="px-6 py-2 text-right font-medium">Variance</th>
                  <th className="px-6 py-2 text-right font-medium">Variance %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.lines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-4 text-center text-muted-foreground">
                      No budget or actual activity in this period.
                    </td>
                  </tr>
                ) : (
                  report.lines.map((line) => (
                    <tr key={line.accountId}>
                      <td className="px-6 py-2.5">
                        <span className="font-mono text-xs text-muted-foreground">{line.code}</span> {line.name}
                        {line.unbudgetedActivity && (
                          <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                            No budget line
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={line.budgetAmount} currency={report.currency} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={line.actualAmount} currency={report.currency} />
                      </td>
                      <td className="px-6 py-2.5 text-right text-muted-foreground">
                        <MoneyDisplay amount={line.variance} currency={report.currency} showSign />
                      </td>
                      <td className="px-6 py-2.5 text-right text-muted-foreground">
                        {line.variancePercent === null ? "—" : `${line.variancePercent}%`}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot className="border-t-2 border-border font-semibold">
                <tr>
                  <td className="px-6 py-3">Total</td>
                  <td className="px-6 py-3 text-right">
                    <MoneyDisplay amount={report.totalBudget} currency={report.currency} />
                  </td>
                  <td className="px-6 py-3 text-right">
                    <MoneyDisplay amount={report.totalActual} currency={report.currency} />
                  </td>
                  <td className="px-6 py-3 text-right">
                    <MoneyDisplay amount={report.totalVariance} currency={report.currency} showSign />
                  </td>
                  <td className="px-6 py-3" />
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
