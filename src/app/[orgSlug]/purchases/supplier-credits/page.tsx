import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function SupplierCreditsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManage = roleHasPermission(actor.role, "supplier_credit:manage");
  const credits = await SupplierCreditService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Supplier Credits</h1>
          <p className="text-sm text-muted-foreground">Returns and pricing corrections that reduce what you owe a supplier.</p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/supplier-credits/new`}>
              <Plus /> New credit note
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {credits.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No supplier credit notes yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Credit #</th>
                  <th className="px-6 py-2 font-medium">Supplier</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                  <th className="px-6 py-2 text-right font-medium">Applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {credits.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/50">
                    <td className="px-6 py-3">
                      <Link href={`/${org.slug}/purchases/supplier-credits/${c.id}`} className="font-medium hover:underline">
                        {c.creditNoteNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3">{c.supplier.displayName}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <MoneyDisplay amount={c.total} currency={c.currency} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <MoneyDisplay amount={c.amountApplied} currency={c.currency} />
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
