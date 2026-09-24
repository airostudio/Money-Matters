import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { BillService } from "@/domain/purchases/bill-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { Money } from "@/domain/money/money";
import { applyCreditToBillAction, approveAndPostCreditAction, voidCreditAction } from "../../actions";

export default async function SupplierCreditDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; creditId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const credit = await SupplierCreditService.get(actor, params.creditId);
  if (!credit) notFound();

  const canManage = roleHasPermission(actor.role, "supplier_credit:manage");
  const canPost = roleHasPermission(actor.role, "supplier_credit:post");
  const canVoid = roleHasPermission(actor.role, "supplier_credit:void");

  const boundPost = approveAndPostCreditAction.bind(null, org.slug, credit.id);
  const boundVoid = voidCreditAction.bind(null, org.slug, credit.id);
  const boundApply = applyCreditToBillAction.bind(null, org.slug, credit.id);

  const remaining = Money.of(credit.total, credit.currency).subtract(Money.of(credit.amountApplied, credit.currency));
  const canApply = (credit.status === "APPROVED" || credit.status === "PART_APPLIED") && canManage;

  let applicableBills: Awaited<ReturnType<typeof BillService.list>> = [];
  if (canApply) {
    const allBills = await BillService.list(actor, { supplierContactId: credit.supplierContactId });
    applicableBills = allBills.filter((b) => (b.status === "APPROVED" || b.status === "PART_PAID") && Number(b.total) - Number(b.amountPaid) > 0);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{credit.creditNoteNumber}</h1>
        <StatusBadge status={credit.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href={`/${org.slug}/purchases/suppliers/${credit.supplierContactId}`} className="hover:underline">
          {credit.supplier.displayName}
        </Link>
        {credit.memo && <> · {credit.memo}</>}
      </p>
      {credit.journalEntryId && (
        <p className="text-sm">
          Posted as{" "}
          <Link href={`/${org.slug}/accounting/journals/${credit.journalEntryId}`} className="text-primary hover:underline">
            journal entry
          </Link>
        </p>
      )}

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Description</th>
                <th className="px-6 py-2 text-right font-medium">Qty</th>
                <th className="px-6 py-2 text-right font-medium">Unit price</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {credit.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">{line.description}</td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={credit.currency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.lineAmount} currency={credit.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={3} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={credit.total} currency={credit.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-6 py-2 text-right text-muted-foreground">
                  Remaining to apply
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={remaining.toString()} currency={credit.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {credit.allocations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Applied against</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {credit.allocations.map((a) => (
                  <tr key={a.allocation.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/purchases/bills/${a.bill.id}`} className="hover:underline">
                        {a.bill.billNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={a.allocation.amount} currency={credit.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {credit.status === "DRAFT" && canPost && (
        <div className="flex justify-end">
          <form action={boundPost}>
            <Button type="submit">Approve &amp; post</Button>
          </form>
        </div>
      )}

      {canApply && applicableBills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Apply to an outstanding bill</CardTitle>
          </CardHeader>
          <form action={boundApply}>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="billId">Bill</Label>
                <select id="billId" name="billId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {applicableBills.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.billNumber} — outstanding {(Number(b.total) - Number(b.amountPaid)).toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount to apply</Label>
                <Input id="amount" name="amount" inputMode="decimal" defaultValue={remaining.toString()} required />
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Apply credit</Button>
            </div>
          </form>
        </Card>
      )}

      {canVoid && credit.status !== "VOID" && credit.status !== "DRAFT" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Void this credit note</CardTitle>
          </CardHeader>
          <form action={boundVoid}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" required />
              </div>
              <Button type="submit" variant="outline">
                Void
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
