import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { AgedReceivablesService, AGING_BUCKETS, type AgingBucket } from "@/domain/sales/aged-receivables-service";
import { Card, CardContent } from "@/components/ui/card";
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
  const rows = await AgedReceivablesService.get(actor);

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
