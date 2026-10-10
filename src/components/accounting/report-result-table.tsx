import { Card, CardContent } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import type { ReportBuilderResult } from "@/domain/reporting/report-builder-service";

/**
 * The report-builder result grid, shared by the Report Builder page and NL
 * reporting's "Ask a question" page — both render the exact same
 * deterministically-computed `ReportBuilderResult`, which is the point: NL
 * reporting is a different front door onto the same engine, never a
 * separate rendering path that could drift from it.
 */
export function ReportResultTable({ result }: { result: ReportBuilderResult | null }) {
  if (!result) {
    return (
      <Card>
        <CardContent className="px-6 py-8 text-center text-sm text-muted-foreground">
          That configuration couldn&apos;t be run — check the date range and account types.
        </CardContent>
      </Card>
    );
  }

  if (result.rows.length === 0) {
    return (
      <Card>
        <CardContent className="px-6 py-8 text-center text-sm text-muted-foreground">
          No activity matches this configuration.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-6 py-2 font-medium">Row</th>
              {result.comparisonColumn && (
                <th className="px-6 py-2 text-right font-medium">{result.comparisonColumn.label}</th>
              )}
              {result.columns.map((c) => (
                <th key={c.label + c.to} className="px-6 py-2 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.rows.map((row) => (
              <tr key={row.key}>
                <td className="px-6 py-2.5">
                  {row.code && <span className="font-mono text-xs text-muted-foreground">{row.code}</span>} {row.name}
                </td>
                {result.comparisonColumn && (
                  <td className="px-6 py-2.5 text-right text-muted-foreground">
                    <MoneyDisplay amount={row.comparisonValue ?? "0"} currency={result.currency} />
                  </td>
                )}
                {row.values.map((v, i) => (
                  <td key={i} className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={v} currency={result.currency} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border font-semibold">
            <tr>
              <td className="px-6 py-3">Total</td>
              {result.comparisonColumn && (
                <td className="px-6 py-3 text-right">
                  <MoneyDisplay amount={result.comparisonGrandTotal ?? "0"} currency={result.currency} showSign />
                </td>
              )}
              {result.grandTotals.map((t, i) => (
                <td key={i} className="px-6 py-3 text-right">
                  <MoneyDisplay amount={t} currency={result.currency} showSign />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}
