import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function PaymentRunsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManage = roleHasPermission(actor.role, "payment_run:manage");
  const runs = await PaymentRunService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payment Runs</h1>
          <p className="text-sm text-muted-foreground">
            Batch several approved bills for payment. Whoever prepares a run cannot also approve it (except in a
            one-person organization — see the run detail page for why).
          </p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/payment-runs/new`}>
              <Plus /> New payment run
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No payment runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Run #</th>
                  <th className="px-6 py-2 font-medium">Payment date</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/50">
                    <td className="px-6 py-3">
                      <Link href={`/${org.slug}/purchases/payment-runs/${r.id}`} className="font-medium hover:underline">
                        {r.runNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3">{new Date(r.paymentDate).toLocaleDateString("en-AU")}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <MoneyDisplay amount={r.totalAmount} currency={r.currency} />
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
