import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { AccountService } from "@/domain/accounts/account-service";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { monthlyColumns } from "@/domain/reporting/period-presets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/accounting/money-display";
import {
  activateBudgetAction,
  archiveBudgetAction,
  removeLineAction,
  setAccountLinesAction,
} from "../actions";

const TYPE_LABELS: Record<string, string> = {
  BASELINE: "Baseline",
  REVISED_FORECAST: "Revised Forecast",
  ROLLING_FORECAST: "Rolling Forecast",
};

function formatDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function BudgetDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; budgetId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const budget = await BudgetService.get(actor, params.budgetId);
  if (!budget) {
    return <p className="text-sm text-muted-foreground">Budget not found.</p>;
  }

  const [lines, accounts, dimensions] = await Promise.all([
    BudgetService.getLines(actor, budget.id),
    AccountService.list(actor),
    DimensionService.listActive(actor),
  ]);

  const columns = monthlyColumns({ from: budget.periodStart, to: budget.periodEnd });
  const isEditable = budget.status === "DRAFT";

  // Group existing lines by account + dimension value for a compact "one row per account" table.
  const grouped = new Map<string, { accountCode: string; accountName: string; dimensionValueLabel: string | null; byMonth: Map<string, { id: string; amount: string }> }>();
  for (const line of lines) {
    const key = `${line.accountId}:${line.dimensionValueId ?? ""}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        accountCode: line.accountCode,
        accountName: line.accountName,
        dimensionValueLabel: line.dimensionValueLabel,
        byMonth: new Map(),
      });
    }
    grouped.get(key)!.byMonth.set(formatDate(line.periodStart).slice(0, 7), { id: line.id, amount: line.amount });
  }

  const setLinesAction = setAccountLinesAction.bind(null, org.slug, budget.id);
  const removeAction = removeLineAction.bind(null, org.slug, budget.id);
  const activate = activateBudgetAction.bind(null, org.slug, budget.id);
  const archive = archiveBudgetAction.bind(null, org.slug, budget.id);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{budget.name}</h1>
          <p className="text-sm text-muted-foreground">
            {TYPE_LABELS[budget.type] ?? budget.type} · {formatDate(budget.periodStart)} – {formatDate(budget.periodEnd)} ·{" "}
            <span className="font-medium">{budget.status}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/${org.slug}/accounting/reports/budget-vs-actual?budgetId=${budget.id}&from=${formatDate(budget.periodStart)}&to=${formatDate(budget.periodEnd)}`}
            >
              Budget vs. Actual
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/${org.slug}/budgets/${budget.id}/rolling-forecast`}>Create rolling forecast</Link>
          </Button>
          {isEditable && (
            <form action={activate}>
              <Button type="submit" size="sm">
                Activate
              </Button>
            </form>
          )}
          {budget.status !== "ARCHIVED" && (
            <form action={archive}>
              <Button type="submit" size="sm" variant="destructive">
                Archive
              </Button>
            </form>
          )}
        </div>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {searchParams.error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {grouped.size === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No lines entered yet. Use the form below to add one.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Account</th>
                  <th className="p-3">Dimension</th>
                  {columns.map((c) => (
                    <th key={c.label} className="p-3 text-right">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...grouped.entries()].map(([key, g]) => (
                  <tr key={key} className="border-b border-border last:border-0">
                    <td className="p-3 font-medium">
                      {g.accountCode} · {g.accountName}
                    </td>
                    <td className="p-3 text-muted-foreground">{g.dimensionValueLabel ?? "—"}</td>
                    {columns.map((c) => {
                      const ym = formatDate(c.from).slice(0, 7);
                      const cell = g.byMonth.get(ym);
                      return (
                        <td key={ym} className="p-3 text-right">
                          {cell ? (
                            <span className="inline-flex items-center gap-2">
                              <MoneyDisplay amount={cell.amount} currency={org.baseCurrency} />
                              {isEditable && (
                                <form action={removeAction}>
                                  <input type="hidden" name="lineId" value={cell.id} />
                                  <button type="submit" className="text-xs text-muted-foreground hover:text-destructive" title="Remove">
                                    ×
                                  </button>
                                </form>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {isEditable && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enter an account&apos;s figures for this budget&apos;s whole period</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={setLinesAction} className="space-y-4">
              <input type="hidden" name="periodStart" value={formatDate(budget.periodStart)} />
              <input type="hidden" name="periodEnd" value={formatDate(budget.periodEnd)} />
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="accountId">Account</Label>
                  <select
                    id="accountId"
                    name="accountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {accounts
                      .filter((a) => a.type === "REVENUE" || a.type === "EXPENSE")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dimensionValueId">Dimension value (optional)</Label>
                  <select
                    id="dimensionValueId"
                    name="dimensionValueId"
                    defaultValue=""
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Whole organization (no dimension)</option>
                    {dimensions.map((d) => (
                      <optgroup key={d.id} label={d.name}>
                        {d.values.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                {columns.map((c, i) => (
                  <div key={c.label} className="space-y-1">
                    <Label htmlFor={`month-${i}`} className="text-xs">
                      {c.label}
                    </Label>
                    <Input id={`month-${i}`} name={`month-${i}`} type="number" step="0.01" placeholder="0.00" />
                  </div>
                ))}
              </div>

              <Button type="submit">Save account&apos;s figures</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
