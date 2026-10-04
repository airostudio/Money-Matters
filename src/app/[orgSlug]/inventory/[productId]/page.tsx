import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ProductService } from "@/domain/inventory/product-service";
import { InventoryService } from "@/domain/inventory/inventory-service";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { createAdjustmentAction, setProductActiveAction } from "../actions";

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; productId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const product = await ProductService.get(actor, params.productId);
  if (!product) notFound();

  const isTracked = product.type === "TRACKED_INVENTORY";
  const [movements, accounts] = await Promise.all([
    isTracked ? InventoryService.listMovements(actor, product.id) : Promise.resolve([]),
    isTracked ? AccountService.list(actor) : Promise.resolve([]),
  ]);
  const adjustmentAccounts = accounts.filter((a) => a.type === "EXPENSE" || a.type === "LIABILITY" || a.type === "ASSET");

  const boundAdjust = createAdjustmentAction.bind(null, org.slug, product.id);
  const boundSetActive = setProductActiveAction.bind(null, org.slug, product.id);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {product.sku} · {product.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {product.type.toLowerCase().replace(/_/g, " ")} — {product.isActive ? "Active" : "Inactive"}
          </p>
        </div>
        <form action={boundSetActive}>
          <input type="hidden" name="isActive" value={product.isActive ? "false" : "true"} />
          <Button type="submit" variant="outline" size="sm">
            {product.isActive ? "Deactivate" : "Reactivate"}
          </Button>
        </form>
      </div>

      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      {isTracked && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">On hand</p>
              <p className="text-lg font-medium">{product.quantityOnHand}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Weighted-average cost</p>
              <p className="text-lg font-medium">
                <MoneyDisplay amount={product.averageUnitCost} currency={org.baseCurrency} />
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Value on hand</p>
              <p className="text-lg font-medium">
                <MoneyDisplay
                  amount={(Number(product.quantityOnHand) * Number(product.averageUnitCost)).toFixed(4)}
                  currency={org.baseCurrency}
                />
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isTracked && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a manual adjustment</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={boundAdjust} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="quantityDelta">Quantity change (+/-)</Label>
                  <Input id="quantityDelta" name="quantityDelta" type="number" step="0.0001" required placeholder="e.g. -2 or 5" />
                </div>
                <div>
                  <Label htmlFor="unitCost">Unit cost (only for an increase)</Label>
                  <Input id="unitCost" name="unitCost" type="number" step="0.0001" placeholder="Required if increasing" />
                </div>
              </div>
              <div>
                <Label htmlFor="adjustmentAccountId">Adjustment account</Label>
                <select id="adjustmentAccountId" name="adjustmentAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="" disabled>
                    Select account…
                  </option>
                  {adjustmentAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" required placeholder="e.g. Stocktake correction, damaged stock" />
              </div>
              <Button type="submit">Post adjustment</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {isTracked && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Movement history</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {movements.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No movements yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">Date</th>
                    <th className="p-3">Type</th>
                    <th className="p-3 text-right">Qty Δ</th>
                    <th className="p-3 text-right">Unit cost</th>
                    <th className="p-3 text-right">Balance qty</th>
                    <th className="p-3 text-right">Balance avg. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="p-3 text-muted-foreground">{new Date(m.occurredAt).toLocaleDateString()}</td>
                      <td className="p-3">{m.movementType}</td>
                      <td className="p-3 text-right">{m.quantityDelta}</td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={m.unitCost} currency={org.baseCurrency} />
                      </td>
                      <td className="p-3 text-right">{m.balanceQuantityAfter}</td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={m.balanceAverageCostAfter} currency={org.baseCurrency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
