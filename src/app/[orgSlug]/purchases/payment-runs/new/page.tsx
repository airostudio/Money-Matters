import { requireOrgAndActor } from "@/lib/session";
import { BillService } from "@/domain/purchases/bill-service";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { createPaymentRunAction } from "../../actions";

export default async function NewPaymentRunPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const [allBills, accounts] = await Promise.all([BillService.list(actor), AccountService.list(actor)]);
  const eligibleBills = allBills.filter(
    (b) => (b.status === "APPROVED" || b.status === "PART_PAID") && Number(b.total) - Number(b.amountPaid) > 0,
  );
  const paymentAccounts = accounts.filter((a) => a.type === "ASSET");

  const boundCreate = createPaymentRunAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);

  if (eligibleBills.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="p-6 text-sm text-muted-foreground">There are no outstanding approved bills to pay right now.</CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>New payment run</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="paymentDate">Payment date</Label>
                <Input id="paymentDate" name="paymentDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="paymentAccountId">Pay from</Label>
                <select id="paymentAccountId" name="paymentAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {paymentAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" placeholder="Optional note for this run" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Bills to include</Label>
              <div className="divide-y divide-border rounded-md border border-border">
                {eligibleBills.map((b) => {
                  const outstanding = (Number(b.total) - Number(b.amountPaid)).toFixed(2);
                  return (
                    <label key={b.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                      <span className="flex items-center gap-3">
                        <input type="checkbox" name="billId" value={b.id} className="size-4" />
                        {b.billNumber} — {b.supplier.displayName}
                      </span>
                      <MoneyDisplay amount={outstanding} currency={b.currency} />
                    </label>
                  );
                })}
              </div>
            </div>
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Create run</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
