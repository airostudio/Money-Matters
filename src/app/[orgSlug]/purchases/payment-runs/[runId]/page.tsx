import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { approvePaymentRunAction, cancelPaymentRunAction, submitPaymentRunAction } from "../../actions";

export default async function PaymentRunDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; runId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const run = await PaymentRunService.get(actor, params.runId);
  if (!run) notFound();

  const canManage = roleHasPermission(actor.role, "payment_run:manage");
  const canApprove = roleHasPermission(actor.role, "payment_run:approve");
  const isCreator = actor.userId === run.createdById;

  const boundSubmit = submitPaymentRunAction.bind(null, org.slug, run.id);
  const boundApprove = approvePaymentRunAction.bind(null, org.slug, run.id);
  const boundCancel = cancelPaymentRunAction.bind(null, org.slug, run.id);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{run.runNumber}</h1>
        <StatusBadge status={run.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        Payment date {new Date(run.paymentDate).toLocaleDateString("en-AU")}
        {run.memo && <> · {run.memo}</>}
      </p>

      {searchParams.error && (
        <p className="whitespace-pre-wrap rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      {run.status === "AWAITING_APPROVAL" && isCreator && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
          You prepared this run — a different user must approve it (segregation of duties). If you are the
          organization&apos;s only eligible approver, approving it yourself is allowed and recorded in the audit trail.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Bill</th>
                <th className="px-6 py-2 font-medium">Supplier</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {run.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-6 py-2.5">
                    <Link href={`/${org.slug}/purchases/bills/${item.bill.id}`} className="hover:underline">
                      {item.bill.billNumber}
                    </Link>
                  </td>
                  <td className="px-6 py-2.5">{item.supplier.displayName}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={item.amount} currency={run.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={2} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={run.totalAmount} currency={run.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        {run.status === "DRAFT" && canManage && (
          <>
            <form action={boundCancel}>
              <input type="hidden" name="reason" value="Cancelled before submission" />
              <Button type="submit" variant="outline">
                Cancel
              </Button>
            </form>
            <form action={boundSubmit}>
              <Button type="submit">Submit for approval</Button>
            </form>
          </>
        )}
        {run.status === "AWAITING_APPROVAL" && canApprove && (
          <form action={boundApprove}>
            <Button type="submit">Approve &amp; pay</Button>
          </form>
        )}
      </div>

      {run.status === "AWAITING_APPROVAL" && canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cancel this run</CardTitle>
          </CardHeader>
          <form action={boundCancel}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" required />
              </div>
              <Button type="submit" variant="outline">
                Cancel run
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
