import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function PurchaseOrdersPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManage = roleHasPermission(actor.role, "purchase_order:manage");
  const purchaseOrders = await PurchaseOrderService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground">
            Order goods from a supplier, track what&apos;s been received, and convert to a bill.
          </p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/purchase-orders/new`}>
              <Plus /> New purchase order
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {purchaseOrders.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No purchase orders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">PO #</th>
                  <th className="px-6 py-2 font-medium">Supplier</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {purchaseOrders.map((po) => (
                  <tr key={po.id} className="hover:bg-muted/50">
                    <td className="px-6 py-3">
                      <Link href={`/${org.slug}/purchases/purchase-orders/${po.id}`} className="font-medium hover:underline">
                        {po.poNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3">{po.supplier.displayName}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={po.status} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <MoneyDisplay amount={po.total} currency={po.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
