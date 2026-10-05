import { requireOrgAndActor } from "@/lib/session";
import { ManagementPackService } from "@/domain/reporting/management-pack-service";
import { currentMonthRange, formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";

function Kpi({ label, amount, currency, showSign }: { label: string; amount: string; currency: string; showSign?: boolean }) {
  return (
    <div className="space-y-1 rounded-md border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">
        <MoneyDisplay amount={amount} currency={currency} showSign={showSign} />
      </p>
    </div>
  );
}

/**
 * Master spec §33's management report pack: P&L + Balance Sheet + Cash Flow
 * bundled with a short AI commentary, generated on demand. See
 * `src/domain/reporting/management-pack-service.ts`'s doc comment for why
 * this is on-demand only (no job queue exists to schedule it).
 */
export default async function ManagementPackPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { from?: string; to?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const defaultRange = currentMonthRange();
  const from = parseDateParam(searchParams.from) ?? defaultRange.from;
  const to = parseDateParam(searchParams.to) ?? defaultRange.to;

  const pack = await ManagementPackService.generate(actor, { from, to }, to);
  const currency = org.baseCurrency;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Management Pack</h1>
          <p className="text-sm text-muted-foreground">
            {from.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })} –{" "}
            {to.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>
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
            To (also the Balance Sheet as-of date)
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

      {pack.commentary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">AI commentary</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed">{pack.commentary}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Profit &amp; Loss —{" "}
            <a href={`/${org.slug}/accounting/reports/profit-and-loss?from=${formatDateParam(from)}&to=${formatDateParam(to)}`} className="text-primary hover:underline text-sm font-normal">
              view full report
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <Kpi label="Total Revenue" amount={pack.profitAndLoss.totalRevenue} currency={currency} />
          <Kpi label="Total Expenses" amount={pack.profitAndLoss.totalExpenses} currency={currency} />
          <Kpi label="Net Profit" amount={pack.profitAndLoss.netProfit} currency={currency} showSign />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Balance Sheet —{" "}
            <a href={`/${org.slug}/accounting/reports/balance-sheet?asOf=${formatDateParam(to)}`} className="text-primary hover:underline text-sm font-normal">
              view full report
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Kpi label="Total Assets" amount={pack.balanceSheet.totalAssets} currency={currency} />
            <Kpi label="Total Liabilities" amount={pack.balanceSheet.totalLiabilities} currency={currency} />
            <Kpi label="Total Equity" amount={pack.balanceSheet.totalEquity} currency={currency} />
          </div>
          <p className={`text-sm ${pack.balanceSheet.isBalanced ? "text-success" : "text-destructive"}`}>
            {pack.balanceSheet.isBalanced ? "✓ Balanced" : "✗ Not balanced"} — Assets = Liabilities + Equity.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Cash Flow Statement —{" "}
            <a href={`/${org.slug}/accounting/reports/cash-flow?from=${formatDateParam(from)}&to=${formatDateParam(to)}`} className="text-primary hover:underline text-sm font-normal">
              view full report
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <Kpi label="Net Cash from Operating" amount={pack.cashFlow.netCashFromOperating} currency={currency} showSign />
          <Kpi label="Net Change in Cash" amount={pack.cashFlow.netChangeInCash} currency={currency} showSign />
          <Kpi label="Ending Cash" amount={pack.cashFlow.endingCashActual} currency={currency} />
        </CardContent>
      </Card>

      {pack.budgetVsActual ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Budget vs. Actual — {pack.budgetVsActual.budgetName} —{" "}
              <a
                href={`/${org.slug}/accounting/reports/budget-vs-actual?budgetId=${pack.budgetVsActual.budgetId}&from=${formatDateParam(from)}&to=${formatDateParam(to)}`}
                className="text-primary hover:underline text-sm font-normal"
              >
                view full report
              </a>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3">
            <Kpi label="Total Budget" amount={pack.budgetVsActual.totalBudget} currency={pack.budgetVsActual.currency} />
            <Kpi label="Total Actual" amount={pack.budgetVsActual.totalActual} currency={pack.budgetVsActual.currency} />
            <Kpi label="Variance" amount={pack.budgetVsActual.totalVariance} currency={pack.budgetVsActual.currency} showSign />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No ACTIVE baseline budget covers this period — Budget vs. Actual is omitted from this pack. Create and
            activate a budget to add this section.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
