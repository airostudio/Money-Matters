import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { BillService } from "@/domain/purchases/bill-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { billStatusEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

type BillStatus = (typeof billStatusEnum.enumValues)[number];

export default async function BillsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { status?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && billStatusEnum.enumValues.includes(searchParams.status as BillStatus)
      ? (searchParams.status as BillStatus)
      : undefined;

  const bills = await BillService.list(actor, { status: statusFilter });
  const canManage = roleHasPermission(actor.role, "supplier_bill:manage");
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
          <p className="text-sm text-muted-foreground">Every bill received from a supplier.</p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/bills/new`}>
              <Plus /> New bill
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/${org.slug}/purchases/bills`}
          className={`rounded-full px-3 py-1 ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {billStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/purchases/bills?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {bills.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No bills to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Bill</th>
                  <th className="px-6 py-2 font-medium">Supplier</th>
                  <th className="px-6 py-2 font-medium">Due</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                  <th className="px-6 py-2 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bills.map((bill) => {
                  const outstanding = (Number(bill.total) - Number(bill.amountPaid)).toFixed(4);
                  const isOverdue = !["DRAFT", "VOID", "PAID"].includes(bill.status) && new Date(bill.dueDate) < now;
                  return (
                    <tr key={bill.id}>
                      <td className="px-6 py-2.5">
                        <Link href={`/${org.slug}/purchases/bills/${bill.id}`} className="font-medium hover:underline">
                          {bill.billNumber}
                        </Link>
                        {bill.supplierReference && (
                          <div className="text-xs text-muted-foreground">{bill.supplierReference}</div>
                        )}
                      </td>
                      <td className="px-6 py-2.5">{bill.supplier.displayName}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {new Date(bill.dueDate).toLocaleDateString("en-AU")}
                      </td>
                      <td className="px-6 py-2.5">
                        <StatusBadge status={isOverdue ? "OVERDUE" : bill.status} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={bill.total} currency={bill.currency} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={outstanding} currency={bill.currency} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
