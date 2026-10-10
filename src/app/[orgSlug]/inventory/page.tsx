import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { ProductService } from "@/domain/inventory/product-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function InventoryPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const productList = await ProductService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            Catalog of sellable/purchasable items — tracked inventory, non-inventory goods and services.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/${org.slug}/inventory/valuation`}>Valuation</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/${org.slug}/inventory/reorder`}>Reorder alerts</Link>
          </Button>
          <Can role={actor.role} permission="product:manage">
            <Button asChild size="sm">
              <Link href={`/${org.slug}/inventory/new`}>
                <Plus /> New product
              </Link>
            </Button>
          </Can>
        </div>
      </div>

      {productList.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No products to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Name</th>
                  <th className="p-3">Type</th>
                  <th className="p-3 text-right">On hand</th>
                  <th className="p-3 text-right">Avg. cost</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {productList.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/inventory/${p.id}`} className="font-medium hover:underline">
                        {p.sku}
                      </Link>
                    </td>
                    <td className="p-3">{p.name}</td>
                    <td className="p-3 text-muted-foreground">{p.type.toLowerCase().replace(/_/g, " ")}</td>
                    <td className="p-3 text-right">{p.type === "TRACKED_INVENTORY" ? p.quantityOnHand : "—"}</td>
                    <td className="p-3 text-right">
                      {p.type === "TRACKED_INVENTORY" ? (
                        <MoneyDisplay amount={p.averageUnitCost} currency={org.baseCurrency} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground">{p.isActive ? "Active" : "Inactive"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
