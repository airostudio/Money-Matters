import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/accounting/money-display";
import type { BalanceSheetLine } from "@/domain/reporting/financial-statements";

function SectionRows({
  lines,
  currency,
  orgSlug,
  hasComparison,
  asOf,
}: {
  lines: BalanceSheetLine[];
  currency: string;
  orgSlug: string;
  hasComparison: boolean;
  asOf: string;
}) {
  return (
    <>
      {lines.map((line, idx) => (
        <tr key={line.accountId ?? `computed-${idx}`}>
          <td className="px-6 py-2.5">
            {line.accountId ? (
              <Link
                href={`/${orgSlug}/accounting/accounts/${line.accountId}/transactions?to=${asOf}`}
                className="text-primary hover:underline"
              >
                {line.code && <span className="font-mono text-xs text-muted-foreground">{line.code}</span>} {line.name}
              </Link>
            ) : (
              <span className="italic text-muted-foreground">{line.name}</span>
            )}
          </td>
          <td className="px-6 py-2.5 text-right">
            <MoneyDisplay amount={line.amount} currency={currency} />
          </td>
          {hasComparison && (
            <td className="px-6 py-2.5 text-right text-muted-foreground">
              <MoneyDisplay amount={line.comparisonAmount ?? "0.0000"} currency={currency} />
            </td>
          )}
        </tr>
      ))}
    </>
  );
}

export default async function BalanceSheetPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { asOf?: string; compareAsOf?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const asOf = parseDateParam(searchParams.asOf) ?? new Date();
  const compareAsOf = parseDateParam(searchParams.compareAsOf);

  const report = await ReportingService.getBalanceSheet(actor, asOf, compareAsOf);
  const hasComparison = compareAsOf !== undefined;
  const currency = org.baseCurrency;
  const asOfParam = formatDateParam(asOf);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Balance Sheet</h1>
          <p className="text-sm text-muted-foreground">
            As of {asOf.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}
            {hasComparison && compareAsOf && (
              <> vs. {compareAsOf.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })}</>
            )}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href={`/${org.slug}/accounting/reports/balance-sheet/export?asOf=${asOfParam}${compareAsOf ? `&compareAsOf=${formatDateParam(compareAsOf)}` : ""}`}
          >
            Export CSV
          </a>
        </Button>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="asOf" className="text-xs font-medium text-muted-foreground">
            As of
          </label>
          <input
            type="date"
            id="asOf"
            name="asOf"
            defaultValue={asOfParam}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="compareAsOf" className="text-xs font-medium text-muted-foreground">
            Compare to (optional)
          </label>
          <input
            type="date"
            id="compareAsOf"
            name="compareAsOf"
            defaultValue={compareAsOf ? formatDateParam(compareAsOf) : ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <Button type="submit" size="sm">
          Update
        </Button>
      </form>

      <div
        className={`rounded-md border p-4 text-sm ${
          report.isBalanced
            ? "border-success/30 bg-success/10 text-success"
            : "border-destructive/30 bg-destructive/10 text-destructive"
        }`}
      >
        {report.isBalanced ? (
          <>✓ Balanced — Assets = Liabilities + Equity.</>
        ) : (
          <>
            ✗ Out of balance by <MoneyDisplay amount={report.difference} currency={currency} /> — Assets minus
            Liabilities+Equity. This should never happen from normal use; it would indicate a bug in the ledger or
            reporting layer, not a real accounting discrepancy.
          </>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Account</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
                {hasComparison && <th className="px-6 py-2 text-right font-medium">Comparison</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr className="bg-muted/40">
                <td colSpan={hasComparison ? 3 : 2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Assets
                </td>
              </tr>
              <SectionRows lines={report.assets} currency={currency} orgSlug={org.slug} hasComparison={hasComparison} asOf={asOfParam} />
              <tr className="font-medium">
                <td className="px-6 py-2.5">Total Assets</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={report.totalAssets} currency={currency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalAssetsComparison ?? "0.0000"} currency={currency} />
                  </td>
                )}
              </tr>

              <tr className="bg-muted/40">
                <td colSpan={hasComparison ? 3 : 2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Liabilities
                </td>
              </tr>
              <SectionRows lines={report.liabilities} currency={currency} orgSlug={org.slug} hasComparison={hasComparison} asOf={asOfParam} />
              <tr className="font-medium">
                <td className="px-6 py-2.5">Total Liabilities</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={report.totalLiabilities} currency={currency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalLiabilitiesComparison ?? "0.0000"} currency={currency} />
                  </td>
                )}
              </tr>

              <tr className="bg-muted/40">
                <td colSpan={hasComparison ? 3 : 2} className="px-6 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  Equity
                </td>
              </tr>
              <SectionRows lines={report.equity} currency={currency} orgSlug={org.slug} hasComparison={hasComparison} asOf={asOfParam} />
              <tr className="font-medium">
                <td className="px-6 py-2.5">Total Equity</td>
                <td className="px-6 py-2.5 text-right">
                  <MoneyDisplay amount={report.totalEquity} currency={currency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalEquityComparison ?? "0.0000"} currency={currency} />
                  </td>
                )}
              </tr>
            </tbody>
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td className="px-6 py-3">Total Liabilities + Equity</td>
                <td className="px-6 py-3 text-right">
                  <MoneyDisplay amount={report.totalLiabilitiesAndEquity} currency={currency} />
                </td>
                {hasComparison && (
                  <td className="px-6 py-3 text-right text-muted-foreground">
                    <MoneyDisplay amount={report.totalLiabilitiesAndEquityComparison ?? "0.0000"} currency={currency} />
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
