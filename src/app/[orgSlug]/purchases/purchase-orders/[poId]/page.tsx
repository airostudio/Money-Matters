import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import {
  cancelPoAction,
  convertPoToBillAction,
  markPoSentAction,
  recordPoReceiptAction,
} from "../../actions";

export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; poId: string };
  searchParams: { error?: string; mismatch?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const po = await PurchaseOrderService.get(actor, params.poId);
  if (!po) notFound();

  const canManage = roleHasPermission(actor.role, "purchase_order:manage");
  const canBill = roleHasPermission(actor.role, "supplier_bill:manage");
  const receivable = po.status === "SENT" || po.status === "PARTIALLY_RECEIVED";
  const convertible = po.status === "PARTIALLY_RECEIVED" || po.status === "RECEIVED";

  const boundMarkSent = markPoSentAction.bind(null, org.slug, po.id);
  const boundCancel = cancelPoAction.bind(null, org.slug, po.id);
  const boundReceipt = recordPoReceiptAction.bind(null, org.slug, po.id);
  const boundConvert = convertPoToBillAction.bind(null, org.slug, po.id);

  const apAccounts = canBill ? (await AccountService.list(actor)).filter((a) => a.type === "LIABILITY") : [];
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{po.poNumber}</h1>
        <StatusBadge status={po.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href={`/${org.slug}/purchases/suppliers/${po.supplierContactId}`} className="hover:underline">
          {po.supplier.displayName}
        </Link>
        {po.memo && <> · {po.memo}</>}
      </p>

      {searchParams.error && (
        <p className="whitespace-pre-wrap rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Description</th>
                <th className="px-6 py-2 text-right font-medium">Ordered</th>
                <th className="px-6 py-2 text-right font-medium">Received</th>
                <th className="px-6 py-2 text-right font-medium">Unit price</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {po.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">{line.description}</td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantityReceived)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={po.currency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.lineAmount} currency={po.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={po.total} currency={po.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {po.status === "DRAFT" && canManage && (
        <div className="flex justify-end gap-2">
          <form action={boundCancel}>
            <input type="hidden" name="reason" value="Cancelled before sending" />
            <Button type="submit" variant="outline">
              Cancel
            </Button>
          </form>
          <form action={boundMarkSent}>
            <Button type="submit">Mark as sent</Button>
          </form>
        </div>
      )}

      {receivable && canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record goods received</CardTitle>
          </CardHeader>
          <form action={boundReceipt}>
            <CardContent className="space-y-4">
              <div className="max-w-xs space-y-2">
                <Label htmlFor="receivedDate">Date received</Label>
                <Input id="receivedDate" name="receivedDate" type="date" defaultValue={today} required />
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">Line</th>
                    <th className="py-1 text-right font-medium">Outstanding</th>
                    <th className="py-1 text-right font-medium">Receive now</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((line) => {
                    const outstanding = (Number(line.quantity) - Number(line.quantityReceived)).toString();
                    return (
                      <tr key={line.id}>
                        <td className="py-1.5">{line.description}</td>
                        <td className="py-1.5 text-right">{outstanding}</td>
                        <td className="py-1.5 text-right">
                          <input type="hidden" name="receiptLineId" value={line.id} />
                          <Input
                            name="receiptQuantity"
                            inputMode="decimal"
                            defaultValue={Number(outstanding) > 0 ? outstanding : "0"}
                            className="ml-auto w-28 text-right"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Record receipt</Button>
            </div>
          </form>
        </Card>
      )}

      {convertible && canBill && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Convert to a bill</CardTitle>
            <p className="text-sm text-muted-foreground">
              Enter what the supplier&apos;s bill actually claims for each line — this may differ from what was ordered or
              received. Any difference is checked (a three-way match) before the bill is created.
            </p>
          </CardHeader>
          <form action={boundConvert}>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="issueDate">Bill date</Label>
                  <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dueDate">Due date</Label>
                  <Input id="dueDate" name="dueDate" type="date" defaultValue={inThirtyDays} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apAccountId">AP account</Label>
                  <select
                    id="apAccountId"
                    name="apAccountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {apAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-3 space-y-2">
                  <Label htmlFor="supplierReference">Supplier&apos;s invoice number</Label>
                  <Input id="supplierReference" name="supplierReference" />
                </div>
              </div>

              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">Line</th>
                    <th className="py-1 text-right font-medium">Ordered @ price</th>
                    <th className="py-1 text-right font-medium">Bill qty</th>
                    <th className="py-1 text-right font-medium">Bill unit price</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="py-1.5">{line.description}</td>
                      <td className="py-1.5 text-right text-muted-foreground">
                        {Number(line.quantity)} @ <MoneyDisplay amount={line.unitPrice} currency={po.currency} />
                      </td>
                      <td className="py-1.5 text-right">
                        <input type="hidden" name="billPoLineId" value={line.id} />
                        <Input name="billQuantity" inputMode="decimal" defaultValue={line.quantityReceived} className="ml-auto w-24 text-right" />
                      </td>
                      <td className="py-1.5 text-right">
                        <Input name="billUnitPrice" inputMode="decimal" defaultValue={line.unitPrice} className="ml-auto w-28 text-right" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {searchParams.mismatch === "1" && (
                <label className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
                  <input type="checkbox" name="acknowledgeDiscrepancies" className="size-4" />
                  I&apos;ve reviewed the differences above and want to proceed anyway.
                </label>
              )}
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Convert to draft bill</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
