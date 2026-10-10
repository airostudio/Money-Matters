import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { AgedReceivablesService, AGING_BUCKETS, type AgingBucket } from "@/domain/sales/aged-receivables-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  days1to30: "1–30 days",
  days31to60: "31–60 days",
  days61to90: "61–90 days",
  days90plus: "90+ days",
};

export default async function AgedReceivablesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const [rows, prioritized] = await Promise.all([
    AgedReceivablesService.get(actor),
    AgedReceivablesService.getWithPriority(actor),
  ]);

  const grandTotals = AGING_BUCKETS.reduce(
    (acc, bucket) => {
      acc[bucket] = rows.reduce((sum, r) => sum + Number(r.totals[bucket]), 0);
      return acc;
    },
    {} as Record<AgingBucket, number>,
  );
  const grandTotal = rows.reduce((sum, r) => sum + Number(r.totalOutstanding), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Aged Receivables</h1>
        <p className="text-sm text-muted-foreground">Who owes what, bucketed by how overdue it is.</p>
      </div>

      {prioritized.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who to chase first</CardTitle>
            <p className="text-sm text-muted-foreground">
              A Collection Priority Score (0–100) per overdue invoice, from its amount, how overdue it is, and this
              customer&rsquo;s own history of paying late — highest first. See docs/roadmap.md: AI-drafted reminder emails
              are deferred, this is the deterministic ranking only.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Invoice</th>
                  <th className="px-6 py-2 font-medium">Customer</th>
                  <th className="px-6 py-2 text-right font-medium">Days overdue</th>
                  <th className="px-6 py-2 text-right font-medium">Customer avg. days late</th>
                  <th className="px-6 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-6 py-2 text-right font-medium">Priority score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {prioritized.slice(0, 15).map((row) => (
                  <tr key={row.invoiceId}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/sales/invoices/${row.invoiceId}`} className="font-medium hover:underline">
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/sales/customers/${row.customerContactId}`} className="hover:underline">
                        {row.customerName}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-right">{row.daysPastDue}</td>
                    <td className="px-6 py-2.5 text-right text-muted-foreground">
                      {row.customerAvgDaysLate === null ? "No history" : `${row.customerAvgDaysLate.toFixed(1)}d`}
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={row.outstanding} currency={org.baseCurrency} />
                    </td>
                    <td className="px-6 py-2.5 text-right font-semibold">{row.priorityScore.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Nothing outstanding — every posted invoice is fully paid.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Customer</th>
                  {AGING_BUCKETS.map((bucket) => (
                    <th key={bucket} className="px-4 py-2 text-right font-medium">
                      {BUCKET_LABELS[bucket]}
                    </th>
                  ))}
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.customerContactId}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/sales/customers/${row.customerContactId}`} className="font-medium hover:underline">
                        {row.customerName}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {row.invoices.map((inv) => (
                          <Link key={inv.invoiceId} href={`/${org.slug}/sales/invoices/${inv.invoiceId}`} className="hover:underline">
                            {inv.invoiceNumber}
                          </Link>
                        ))}
                      </div>
                    </td>
                    {AGING_BUCKETS.map((bucket) => (
                      <td key={bucket} className="px-4 py-2.5 text-right">
                        {Number(row.totals[bucket]) > 0 ? (
                          <MoneyDisplay amount={row.totals[bucket]} currency={org.baseCurrency} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ))}
                    <td className="px-6 py-2.5 text-right font-medium">
                      <MoneyDisplay amount={row.totalOutstanding} currency={org.baseCurrency} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="px-6 py-2.5">Total</td>
                  {AGING_BUCKETS.map((bucket) => (
                    <td key={bucket} className="px-4 py-2.5 text-right">
                      <MoneyDisplay amount={grandTotals[bucket].toFixed(4)} currency={org.baseCurrency} />
                    </td>
                  ))}
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={grandTotal.toFixed(4)} currency={org.baseCurrency} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
