import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { BillService } from "@/domain/purchases/bill-service";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { recordSupplierPaymentAction } from "../../actions";

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; contactId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const supplier = await ContactService.get(actor, params.contactId);
  if (!supplier) notFound();

  const bills = await BillService.list(actor, { supplierContactId: supplier.id });
  const outstandingBills = bills.filter((b) => !["DRAFT", "VOID", "PAID"].includes(b.status));
  const accounts = await AccountService.list(actor);
  const paymentAccounts = accounts.filter((a) => a.type === "ASSET");
  const canRecordPayment = roleHasPermission(actor.role, "supplier_payment:manage") && outstandingBills.length > 0;

  const boundRecordPayment = recordSupplierPaymentAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{supplier.displayName}</h1>
        <p className="text-sm text-muted-foreground">
          {supplier.email ?? "No email"} {supplier.phone && <>· {supplier.phone}</>}
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bills</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {bills.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No bills from this supplier yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Bill</th>
                  <th className="px-6 py-2 font-medium">Due</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                  <th className="px-6 py-2 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bills.map((bill) => (
                  <tr key={bill.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/purchases/bills/${bill.id}`} className="font-medium hover:underline">
                        {bill.billNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {new Date(bill.dueDate).toLocaleDateString("en-AU")}
                    </td>
                    <td className="px-6 py-2.5">
                      <StatusBadge status={bill.status} />
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={bill.total} currency={bill.currency} />
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={(Number(bill.total) - Number(bill.amountPaid)).toFixed(4)} currency={bill.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {canRecordPayment && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a payment</CardTitle>
          </CardHeader>
          <form action={boundRecordPayment}>
            <input type="hidden" name="supplierContactId" value={supplier.id} />
            <input type="hidden" name="returnPath" value={`/${org.slug}/purchases/suppliers/${supplier.id}`} />
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="paymentDate">Date</Label>
                  <Input id="paymentDate" name="paymentDate" type="date" defaultValue={today} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">Amount paid</Label>
                  <Input id="amount" name="amount" inputMode="decimal" placeholder="0.00" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="method">Method</Label>
                  <select id="method" name="method" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    <option value="BANK_TRANSFER">Bank transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentAccountId">Pay from</Label>
                  <select
                    id="paymentAccountId"
                    name="paymentAccountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {paymentAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reference">Reference</Label>
                <Input id="reference" name="reference" placeholder="e.g. bank transaction id" />
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Allocate to bills</p>
                <div className="space-y-2 rounded-md border border-border p-3">
                  {outstandingBills.map((bill) => {
                    const remaining = (Number(bill.total) - Number(bill.amountPaid)).toFixed(2);
                    return (
                      <div key={bill.id} className="flex items-center gap-3 text-sm">
                        <input type="hidden" name="allocationBillId" value={bill.id} />
                        <span className="w-28 shrink-0 font-medium">{bill.billNumber}</span>
                        <span className="w-28 shrink-0 text-xs text-muted-foreground">Outstanding {remaining}</span>
                        <Input
                          name="allocationAmount"
                          inputMode="decimal"
                          placeholder="0.00"
                          defaultValue="0.00"
                          className="h-8 max-w-[140px]"
                        />
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave an allocation at 0.00 to skip that bill — a single payment can be split across several.
                </p>
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Record payment</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
