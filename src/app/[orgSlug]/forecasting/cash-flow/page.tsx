import Link from "next/link";
import { AlertTriangle, Bot, Info } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { CashForecastService } from "@/domain/forecasting/cash-forecast-service";
import { ForecastCommentaryService } from "@/domain/forecasting/commentary";
import { FORECAST_HORIZONS, type ForecastHorizon, type ForecastLine } from "@/domain/forecasting/types";
import { formatMoneyForMessage } from "@/domain/forecasting/forecast-calculations";
import { parseDateParam } from "@/domain/reporting/period-presets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetricCard } from "@/components/accounting/metric-card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { ForecastChart } from "@/components/forecasting/forecast-chart";
import { saveLowCashThresholdAction } from "../actions";

const HORIZON_LABEL: Record<ForecastHorizon, string> = { "7D": "7 days", "30D": "30 days", "60D": "60 days", "90D": "90 days", "12M": "12 months" };

const TIMING_LABEL: Record<string, string> = {
  STATED_DUE_DATE: "Due date",
  OVERDUE_ASSUMED_DUE_NOW: "Overdue — assumed due today",
  OVERDUE_RECEIPT_UNDATED: "Overdue — receipt date unknown",
  SCHEDULED_PAYMENT_RUN: "Payment run date",
  TEMPLATE_SCHEDULE: "Recurring schedule",
  UNVERIFIED: "Due date not verified",
};

function LineTable({ lines, currency, orgSlug }: { lines: ForecastLine[]; currency: string; orgSlug: string }) {
  if (lines.length === 0) return <p className="px-6 pb-6 text-sm text-muted-foreground">None in this horizon.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="p-3">Date</th>
            <th className="p-3">Line</th>
            <th className="p-3">Basis</th>
            <th className="p-3 text-right">In / (out)</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-border align-top last:border-0">
              <td className="p-3 whitespace-nowrap">{l.date ?? <span className="text-muted-foreground">undated</span>}</td>
              <td className="p-3">
                {l.source.href ? (
                  <Link href={`/${orgSlug}${l.source.href}`} className="font-medium text-primary hover:underline">
                    {l.label}
                  </Link>
                ) : (
                  <span className="font-medium">{l.label}</span>
                )}
                {l.counterparty && <span className="text-muted-foreground"> — {l.counterparty}</span>}
                <div className="text-xs text-muted-foreground">Source: {l.source.label}</div>
                {l.note && <div className="mt-1 text-xs text-muted-foreground">{l.note}</div>}
              </td>
              <td className="p-3 text-xs text-muted-foreground">
                {l.kind === "KNOWN" ? (
                  <>
                    <div>{TIMING_LABEL[l.timing] ?? l.timing}</div>
                    {l.statedDate && l.statedDate !== l.date && <div>Stated {l.statedDate}</div>}
                  </>
                ) : l.basis.type === "CUSTOMER_AVG_DAYS_LATE" ? (
                  <>
                    <div>Customer pays {Math.round(l.basis.avgDaysLate)} days {l.basis.avgDaysLate < 0 ? "early" : "late"} on average</div>
                    <div>
                      from {l.basis.settledInvoiceCount ?? "?"} settled invoice(s)
                      {l.basis.settledInvoiceCount !== null && l.basis.settledInvoiceCount < 3 ? " — a thin history" : ""}
                    </div>
                  </>
                ) : (
                  <div>Repeat of the last posted pay run ({l.basis.payFrequency.toLowerCase()}, last paid {l.basis.lastPayDate})</div>
                )}
              </td>
              <td className="p-3 text-right">
                <MoneyDisplay amount={l.direction === "IN" ? l.amount : `-${l.amount}`} currency={currency} showSign={l.direction === "IN"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CashForecastPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { horizon?: string; asOf?: string; commentary?: string; error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const horizon = (FORECAST_HORIZONS as readonly string[]).includes(searchParams.horizon ?? "") ? (searchParams.horizon as ForecastHorizon) : "90D";
  const asOfDate = parseDateParam(searchParams.asOf);
  const forecast = await CashForecastService.generate(actor, { asOfDate, horizon });
  const canManage = roleHasPermission(actor.role, "forecast:manage");
  const commentary = searchParams.commentary === "1" ? await ForecastCommentaryService.forForecast(forecast) : null;
  const orgSlug = params.orgSlug;
  const asOfQuery = searchParams.asOf ? `&asOf=${searchParams.asOf}` : "";

  const known = forecast.lines.filter((l) => l.kind === "KNOWN");
  const statistical = forecast.lines.filter((l) => l.kind === "STATISTICAL");
  const dated = known.filter((l) => l.date !== null);
  const undated = known.filter((l) => l.date === null);
  const warning = forecast.warning;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash Forecast</h1>
          <p className="text-sm text-muted-foreground">
            From {forecast.asOf} for {org.name}, {HORIZON_LABEL[horizon]} ahead. Every figure is computed fresh from your ledger; known commitments and statistical
            projections are kept apart on purpose.
          </p>
        </div>
        <nav aria-label="Forecast horizon" className="flex gap-1">
          {FORECAST_HORIZONS.map((h) => (
            <Button key={h} asChild size="sm" variant={h === horizon ? "default" : "outline"}>
              <Link href={`/${orgSlug}/forecasting/cash-flow?horizon=${h}${asOfQuery}`}>{h}</Link>
            </Button>
          ))}
        </nav>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      {warning.message && (
        <Card className="border-warning/50 bg-warning/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-warning" /> Low-cash warning
              {warning.firstBreach && (
                <span className="text-sm font-normal text-muted-foreground">
                  — first on {warning.firstBreach.date}
                  {warning.firstBreach.daysFromNow > 0 ? ` (in ${warning.firstBreach.daysFromNow} days)` : " (now)"}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{warning.message}</p>
            {warning.knownOnly === null && (
              <p className="text-muted-foreground">
                Only the statistical series breaches the threshold: this warning depends on estimates, not on commitments alone.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {commentary && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="flex flex-row items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">AI commentary</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {commentary}
            <p className="mt-2 text-xs text-muted-foreground">Written from the figures on this page only; it never adds a number of its own.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Cash today"
          value={<MoneyDisplay amount={forecast.openingCash.total} currency={forecast.currency} />}
          hint={`${forecast.openingCash.accounts.length} bank account(s), ledger balance`}
        />
        <MetricCard
          label="Low point — known only"
          value={<MoneyDisplay amount={forecast.knownOnly.lowPoint.balance} currency={forecast.currency} />}
          hint={`on ${forecast.knownOnly.lowPoint.date}`}
        />
        <MetricCard
          label="Low point — incl. statistical"
          value={<MoneyDisplay amount={forecast.withStatistical.lowPoint.balance} currency={forecast.currency} />}
          hint={`on ${forecast.withStatistical.lowPoint.date}`}
        />
        <MetricCard
          label={`Balance at ${HORIZON_LABEL[horizon]}`}
          value={<MoneyDisplay amount={forecast.knownOnly.endBalance} currency={forecast.currency} />}
          hint={`known only · incl. statistical ${formatMoneyForMessage(forecast.withStatistical.endBalance, forecast.currency)}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projected cash balance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ForecastChart
            known={forecast.knownOnly.points}
            statistical={forecast.withStatistical.points}
            threshold={forecast.lowCashThreshold}
            currency={forecast.currency}
          />
          <p className="text-xs text-muted-foreground">
            {forecast.granularity === "WEEKLY"
              ? "Shown weekly for the 12-month view (day-level precision a year out would be false precision); the low points and warning dates above are still day-exact."
              : "End-of-day balances; today already includes anything due today."}
          </p>
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer p-3 text-sm font-medium">Show the numbers</summary>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-border bg-card text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">Date</th>
                    <th className="p-3 text-right">Known commitments only</th>
                    <th className="p-3 text-right">Including statistical</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.knownOnly.points.map((p, i) => (
                    <tr key={p.date} className="border-b border-border last:border-0">
                      <td className="p-3">{p.date}</td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={p.balance} currency={forecast.currency} />
                      </td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={forecast.withStatistical.points[i]!.balance} currency={forecast.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button asChild size="sm" variant="outline">
              <Link href={`/${orgSlug}/forecasting/cash-flow?horizon=${horizon}${asOfQuery}&commentary=1`}>
                <Bot /> Add AI commentary
              </Link>
            </Button>
            <span className="text-xs text-muted-foreground">Optional. Needs an Anthropic API key; written only from the figures above.</span>
          </div>
        </CardContent>
      </Card>

      {forecast.unscheduledKnown.lineIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Info className="size-4 text-muted-foreground" /> Known amounts with no determinable date
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <MoneyDisplay amount={forecast.unscheduledKnown.inflows} currency={forecast.currency} /> owed to you (overdue receivables) and{" "}
              <MoneyDisplay amount={forecast.unscheduledKnown.outflows} currency={forecast.currency} /> owed by you are certain amounts whose payment date no document
              states, so neither series places them on the timeline.
            </p>
            {forecast.unscheduledKnown.outflows !== "0.0000" && (
              <p className="text-muted-foreground">
                If those outflows were all paid today, the known-commitments-only low point would be{" "}
                <MoneyDisplay amount={forecast.unscheduledKnown.lowPointIfUnscheduledOutflowsPaidNow} currency={forecast.currency} /> — a prudence floor, not a prediction.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Known commitments ({dated.length + undated.length})</CardTitle>
          <p className="text-sm text-muted-foreground">
            Grounded in a document or an explicit schedule: open invoices and bills, approved payment runs, active recurring templates, posted payroll.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <LineTable lines={[...dated, ...undated]} currency={forecast.currency} orgSlug={orgSlug} />
        </CardContent>
      </Card>

      <Card className="border-warning/30">
        <CardHeader>
          <CardTitle className="text-base">Statistical projections ({statistical.length})</CardTitle>
          <p className="text-sm text-muted-foreground">
            Estimates from simple averages — a customer&apos;s own historical lateness, a repeat of the last pay run. Not a forecasting model, and never added to the known commitments above.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <LineTable lines={statistical} currency={forecast.currency} orgSlug={orgSlug} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Low-cash threshold</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canManage ? (
            <form action={saveLowCashThresholdAction.bind(null, orgSlug)} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="horizon" value={horizon} />
              <div className="space-y-1">
                <Label htmlFor="lowCashThreshold">Warn when projected cash falls below ({forecast.currency})</Label>
                <Input id="lowCashThreshold" name="lowCashThreshold" defaultValue={forecast.lowCashThreshold} inputMode="decimal" className="w-48" />
              </div>
              <Button type="submit" size="sm">Save</Button>
            </form>
          ) : (
            <p className="text-sm">
              Warning threshold: <MoneyDisplay amount={forecast.lowCashThreshold} currency={forecast.currency} />. Changing it needs the forecast:manage permission.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Default is zero (warn only if cash would go negative).</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What this forecast does and doesn&apos;t include</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {forecast.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
