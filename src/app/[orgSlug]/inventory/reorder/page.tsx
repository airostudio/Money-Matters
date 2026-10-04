import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ReorderAlertService } from "@/domain/inventory/reorder-alert-service";
import { Card, CardContent } from "@/components/ui/card";

export default async function ReorderAlertsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const alerts = await ReorderAlertService.list(actor);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reorder alerts</h1>
        <p className="text-sm text-muted-foreground">
          Active tracked-inventory products at or below their reorder point. Deterministic — this is not a
          stockout-date prediction, which would need sales-velocity forecasting (not yet built).
        </p>
      </div>

      {alerts.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Nothing is below its reorder point right now.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Name</th>
                  <th className="p-3 text-right">On hand</th>
                  <th className="p-3 text-right">Reorder point</th>
                  <th className="p-3 text-right">Suggested reorder qty</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.productId} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/inventory/${a.productId}`} className="font-medium hover:underline">
                        {a.sku}
                      </Link>
                    </td>
                    <td className="p-3">{a.name}</td>
                    <td className="p-3 text-right">{a.quantityOnHand}</td>
                    <td className="p-3 text-right">{a.reorderPoint}</td>
                    <td className="p-3 text-right">{a.reorderQuantity ?? "—"}</td>
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
