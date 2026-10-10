import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { currentMonthRange, formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";
import type { CashFlowLine } from "@/domain/reporting/financial-statements";

function LineRows({
  lines,
  currency,
  orgSlug,
  from,
  to,
}: {
  lines: CashFlowLine[];
  currency: string;
  orgSlug: string;
  from: string;
  to: string;
}) {
  return (
    <>
      {lines.map((line) => (
        <tr key={line.accountId}>
          <td className="px-6 py-2 pl-10">
            <Link
              href={`/${orgSlug}/accounting/accounts/${line.accountId}/transactions?from=${from}&to=${to}`}
              className="text-primary hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground">{line.code}</span> {line.name}
            </Link>
          </td>
          <td className="px-6 py-2 text-right">
            <MoneyDisplay amount={line.amount} currency={currency} showSign />
          </td>
        </tr>
      ))}
    </>
  );
}

export default async function CashFlowPage({
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

  const statement = await ReportingService.getCashFlowStatement(actor, { from, to });
  const currency = org.baseCurrency;
  const fromParam = formatDateParam(from);
  const toParam = formatDateParam(to);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash Flow Statement</h1>
          <p className="text-sm text-muted-foreground">
            {from.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })} –{" "}
            {to.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })} · indirect method
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/${org.slug}/accounting/reports/cash-flow/export?from=${fromParam}&to=${toParam}`}>Export CSV</a>
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
            defaultValue={fromParam}
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
            defaultValue={toParam}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <Button type="submit" size="sm">
          Update
        </Button>
      </form>

      <div
        className={`rounded-md border p-4 text-sm ${
          statement.reconciles
            ? "border-success/30 bg-success/10 text-success"
            : "border-destructive/30 bg-destructive/10 text-destructive"
        }`}
      >
        {statement.reconciles ? (
          <>
            ✓ Reconciles — computed ending cash matches the actual bank account balance (
            <MoneyDisplay amount={statement.endingCashActual} currency={currency} />
            ).
          </>
        ) : (
          <>
            ✗ Does not reconcile: computed ending cash (
            <MoneyDisplay amount={statement.endingCashComputed} currency={currency} />) differs from the actual bank
            balance (<MoneyDisplay amount={statement.endingCashActual} currency={currency} />
            ). This should never happen from normal use.
          </>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              <tr className="bg-muted/40">
                <td colSpan={2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Operating Activities
                </td>
              </tr>
              <tr>
                <td className="px-6 py-2 pl-10">Net Profit</td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={statement.netProfit} currency={currency} showSign />
                </td>
              </tr>
              <LineRows lines={statement.operatingAdjustments} currency={currency} orgSlug={org.slug} from={fromParam} to={toParam} />
              <tr className="font-medium">
                <td className="px-6 py-2.5">Net Cash from Operating Activities</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={statement.netCashFromOperating} currency={currency} showSign />
                </td>
              </tr>

              <tr className="bg-muted/40">
                <td colSpan={2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Investing Activities
                </td>
              </tr>
              {statement.investingActivities.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-2 pl-10 text-muted-foreground">
                    No investing activity this period.
                  </td>
                </tr>
              ) : (
                <LineRows lines={statement.investingActivities} currency={currency} orgSlug={org.slug} from={fromParam} to={toParam} />
              )}
              <tr className="font-medium">
                <td className="px-6 py-2.5">Net Cash from Investing Activities</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={statement.netCashFromInvesting} currency={currency} showSign />
                </td>
              </tr>

              <tr className="bg-muted/40">
                <td colSpan={2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Financing Activities
                </td>
              </tr>
              {statement.financingActivities.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-2 pl-10 text-muted-foreground">
                    No financing activity this period.
                  </td>
                </tr>
              ) : (
                <LineRows lines={statement.financingActivities} currency={currency} orgSlug={org.slug} from={fromParam} to={toParam} />
              )}
              <tr className="font-medium">
                <td className="px-6 py-2.5">Net Cash from Financing Activities</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={statement.netCashFromFinancing} currency={currency} showSign />
                </td>
              </tr>
            </tbody>
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td className="px-6 py-2">Net Change in Cash</td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={statement.netChangeInCash} currency={currency} showSign />
                </td>
              </tr>
              <tr className="font-normal text-muted-foreground">
                <td className="px-6 py-1">Beginning Cash</td>
                <td className="px-6 py-1 text-right">
                  <MoneyDisplay amount={statement.beginningCash} currency={currency} />
                </td>
              </tr>
              <tr>
                <td className="px-6 py-2">Ending Cash</td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={statement.endingCashActual} currency={currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
