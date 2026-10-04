import { requireOrgAndActor } from "@/lib/session";
import { InventoryValuationService } from "@/domain/inventory/valuation-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function InventoryValuationPage({ params }: { params: { orgSlug: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const report = await InventoryValuationService.getValuationReport(actor);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inventory valuation</h1>
        <p className="text-sm text-muted-foreground">
          On-hand quantity × weighted-average cost per product, reconciled against the inventory asset account&apos;s
          own GL balance.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">GL reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.reconciliation.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tracked-inventory products with stock yet.</p>
          ) : (
            report.reconciliation.map((r) => (
              <div key={r.accountId} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                <div>
                  <p className="font-medium">
                    {r.accountCode} · {r.accountName}
                  </p>
                  <p className="text-muted-foreground">
                    Valuation <MoneyDisplay amount={r.valuationTotal} currency={report.currency} /> vs. GL balance{" "}
                    <MoneyDisplay amount={r.glBalance} currency={report.currency} />
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    r.reconciled ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {r.reconciled ? "Reconciled" : `Mismatch: ${r.difference}`}
                </span>
              </div>
            ))
          )}
          <p className={`text-sm font-medium ${report.fullyReconciled ? "text-emerald-600" : "text-destructive"}`}>
            {report.fullyReconciled
              ? "Every inventory asset account reconciles exactly."
              : "One or more accounts do not reconcile — this is a bug, not rounding."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By product</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {report.products.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No tracked-inventory products.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Name</th>
                  <th className="p-3 text-right">On hand</th>
                  <th className="p-3 text-right">Avg. cost</th>
                  <th className="p-3 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {report.products.map((p) => (
                  <tr key={p.productId} className="border-b border-border last:border-0">
                    <td className="p-3">{p.sku}</td>
                    <td className="p-3">{p.name}</td>
                    <td className="p-3 text-right">{p.quantityOnHand}</td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={p.averageUnitCost} currency={report.currency} />
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={p.value} currency={report.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="p-3" colSpan={4}>
                    Total
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={report.totalValuation} currency={report.currency} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
