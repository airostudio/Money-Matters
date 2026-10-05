import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Bot } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ScenarioService, type ScenarioRunResult } from "@/domain/forecasting/scenario-service";
import { ForecastCommentaryService } from "@/domain/forecasting/commentary";
import { CASE_NAMES, type CaseName, type ScenarioCaseResult } from "@/domain/forecasting/scenario-calculations";
import { SCENARIO_TYPE_LABELS } from "@/domain/forecasting/scenario-parameters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { deleteScenarioAction } from "../../actions";

const CASE_LABEL: Record<CaseName, string> = { BEST: "Best case", EXPECTED: "Expected case", WORST: "Worst case" };

function Runway({ months }: { months: string | null }) {
  return months === null ? <span className="text-muted-foreground">beyond the 12 months modelled</span> : <>{months} months</>;
}

function BreakEven({ c }: { c: ScenarioCaseResult }) {
  const b = c.summary.breakEven;
  if (b.status === "NOT_NEEDED") return <span className="text-muted-foreground">no monthly cost to recover</span>;
  if (b.status === "NOT_WITHIN_12_MONTHS") return <span className="text-destructive">not within 12 months</span>;
  return (
    <>
      monthly: {b.monthlyBreakEvenMonth}
      <br />
      cumulative: {b.cumulativePaybackMonth ?? "not within 12 months"}
    </>
  );
}

export default async function ScenarioResultPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; scenarioId: string };
  searchParams: { error?: string; commentary?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const scenario = await ScenarioService.get(actor, params.scenarioId);
  if (!scenario) notFound();

  let result: ScenarioRunResult | null = null;
  let runError: string | null = null;
  try {
    result = await ScenarioService.run(actor, scenario.id);
  } catch (error) {
    runError = error instanceof Error ? error.message : "This scenario could not be run.";
  }
  const commentary = result && searchParams.commentary === "1" ? await ForecastCommentaryService.forScenario(result) : null;
  const canManage = roleHasPermission(actor.role, "scenario:manage");
  const orgSlug = org.slug;
  const currency = result?.currency ?? "AUD";

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${orgSlug}/forecasting/scenarios`} className="hover:underline">
              Scenarios
            </Link>{" "}
            / {SCENARIO_TYPE_LABELS[scenario.type]}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{scenario.name}</h1>
          {scenario.notes && <p className="text-sm text-muted-foreground">{scenario.notes}</p>}
          {result && <p className="text-sm text-muted-foreground">Re-run just now against your current ledger (as of {result.asOf}). Nothing here is posted.</p>}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/${orgSlug}/forecasting/scenarios/${scenario.id}/edit`}>Edit</Link>
            </Button>
            <form action={deleteScenarioAction.bind(null, orgSlug, scenario.id)}>
              <Button type="submit" size="sm" variant="outline">
                Delete
              </Button>
            </form>
          </div>
        )}
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}
      {runError && <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{runError}</p>}

      {result && (
        <>
          <Card className="border-warning/30">
            <CardContent className="space-y-1 p-4 text-sm">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                  Best / Expected / Worst are <strong>modelling assumptions you can edit</strong>, not predictions. Each case lists exactly what it assumes below.
                </span>
              </p>
              {result.baseline.warnings.map((w) => (
                <p key={w} className="pl-6 text-muted-foreground">
                  {w}
                </p>
              ))}
            </CardContent>
          </Card>

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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Baseline vs. cases — next 12 full calendar months</CardTitle>
              <p className="text-sm text-muted-foreground">
                Baseline: {result.baseline.label}. Opening cash <MoneyDisplay amount={result.baseline.openingCash} currency={currency} />.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">12-month view</th>
                    <th className="p-3 text-right">Baseline (unmodified)</th>
                    {CASE_NAMES.map((c) => (
                      <th key={c} className="p-3 text-right">
                        {CASE_LABEL[c]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border">
                    <td className="p-3">Net profit</td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={result.cases.EXPECTED.summary.baselineNetProfit12m} currency={currency} />
                    </td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.scenarioNetProfit12m} currency={currency} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3">Change vs. baseline</td>
                    <td className="p-3 text-right text-muted-foreground">—</td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.twelveMonthNetProfitDelta} currency={currency} showSign />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3 text-muted-foreground">of which revenue</td>
                    <td className="p-3 text-right text-muted-foreground">—</td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.twelveMonthRevenueDelta} currency={currency} showSign />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3 text-muted-foreground">of which expenses (+ = more cost)</td>
                    <td className="p-3 text-right text-muted-foreground">—</td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.twelveMonthExpenseDelta} currency={currency} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3">Cash at month 12 (run-rate)</td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={result.cases.EXPECTED.summary.baselineEndCash} currency={currency} />
                    </td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.scenarioEndCash} currency={currency} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3">Lowest month-end cash</td>
                    <td className="p-3 text-right text-muted-foreground">—</td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <MoneyDisplay amount={result.cases[c].summary.lowestScenarioCash.balance} currency={currency} />
                        <div className="text-xs text-muted-foreground">{result.cases[c].summary.lowestScenarioCash.month}</div>
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-3">Cash runway</td>
                    <td className="p-3 text-right">
                      <Runway months={result.cases.EXPECTED.summary.baselineRunwayMonths} />
                    </td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <Runway months={result.cases[c].summary.scenarioRunwayMonths} />
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3">Break-even</td>
                    <td className="p-3 text-right text-muted-foreground">—</td>
                    {CASE_NAMES.map((c) => (
                      <td key={c} className="p-3 text-right">
                        <BreakEven c={result.cases[c]} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {CASE_NAMES.map((c) => (
              <Card key={c}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{CASE_LABEL[c]} assumes</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-sm">
                    {result.cases[c].assumptions.map((a) => (
                      <li key={a.label}>
                        <span className="text-muted-foreground">{a.label}:</span> {a.value}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>

          {(result.keyFigures.length > 0 || result.derivedInputs.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Figures the model started from</CardTitle>
                <p className="text-sm text-muted-foreground">Derived from your real data — shown so you can check them.</p>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <tbody>
                    {[...result.keyFigures, ...result.derivedInputs].map((d) => (
                      <tr key={d.label} className="border-b border-border last:border-0 align-top">
                        <td className="p-3 font-medium">{d.label}</td>
                        <td className="p-3">{d.value}</td>
                        <td className="p-3 text-xs text-muted-foreground">{d.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {result.forecastContext && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Near-term context: the 90-day cash forecast</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>
                  Known commitments only: lowest <MoneyDisplay amount={result.forecastContext.knownOnlyLowPoint.balance} currency={currency} /> on{" "}
                  {result.forecastContext.knownOnlyLowPoint.date}. Including statistical projections: lowest{" "}
                  <MoneyDisplay amount={result.forecastContext.withStatisticalLowPoint.balance} currency={currency} /> on {result.forecastContext.withStatisticalLowPoint.date}.
                </p>
                {result.forecastContext.warningMessage && <p className="text-muted-foreground">{result.forecastContext.warningMessage}</p>}
                {result.forecastContext.payrollOmitted && <p className="text-xs text-muted-foreground">Payroll lines are omitted for your role.</p>}
                <Link href={`/${orgSlug}/forecasting/cash-flow`} className="text-primary hover:underline">
                  Open the Cash Forecast
                </Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Month by month</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {CASE_NAMES.map((c) => (
                <details key={c} className="rounded-md border border-border">
                  <summary className="cursor-pointer p-3 text-sm font-medium">{CASE_LABEL[c]}</summary>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="p-3">Month</th>
                          <th className="p-3 text-right">Baseline profit</th>
                          <th className="p-3 text-right">Scenario profit</th>
                          <th className="p-3 text-right">Change</th>
                          <th className="p-3 text-right">Baseline cash</th>
                          <th className="p-3 text-right">Scenario cash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.cases[c].months.map((m) => (
                          <tr key={m.month} className="border-b border-border last:border-0">
                            <td className="p-3">{m.month}</td>
                            <td className="p-3 text-right">
                              <MoneyDisplay amount={m.baselineNetProfit} currency={currency} />
                            </td>
                            <td className="p-3 text-right">
                              <MoneyDisplay amount={m.scenarioNetProfit} currency={currency} />
                            </td>
                            <td className="p-3 text-right">
                              <MoneyDisplay amount={m.netProfitDelta} currency={currency} showSign />
                            </td>
                            <td className="p-3 text-right">
                              <MoneyDisplay amount={m.baselineCash} currency={currency} />
                            </td>
                            <td className="p-3 text-right">
                              <MoneyDisplay amount={m.scenarioCash} currency={currency} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm" variant="outline">
              <Link href={`/${orgSlug}/forecasting/scenarios/${scenario.id}?commentary=1`}>
                <Bot /> Add AI commentary
              </Link>
            </Button>
            <span className="text-xs text-muted-foreground">Optional. Written only from the figures above.</span>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {result.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
