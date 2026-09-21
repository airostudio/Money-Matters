import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { invoiceStatusEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { status?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && invoiceStatusEnum.enumValues.includes(searchParams.status as InvoiceStatus)
      ? (searchParams.status as InvoiceStatus)
      : undefined;

  const invoices = await InvoiceService.list(actor, { status: statusFilter });
  const canManage = roleHasPermission(actor.role, "customer_invoice:manage");
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground">Every invoice raised against a customer.</p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/invoices/new`}>
              <Plus /> New invoice
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/${org.slug}/sales/invoices`}
          className={`rounded-full px-3 py-1 ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {invoiceStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/sales/invoices?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {invoices.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No invoices to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Invoice</th>
                  <th className="px-6 py-2 font-medium">Customer</th>
                  <th className="px-6 py-2 font-medium">Due</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                  <th className="px-6 py-2 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((inv) => {
                  const outstanding = (Number(inv.total) - Number(inv.amountPaid)).toFixed(4);
                  const isOverdue = !["DRAFT", "VOID", "PAID"].includes(inv.status) && new Date(inv.dueDate) < now;
                  return (
                    <tr key={inv.id}>
                      <td className="px-6 py-2.5">
                        <Link href={`/${org.slug}/sales/invoices/${inv.id}`} className="font-medium hover:underline">
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-2.5">{inv.customer.displayName}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {new Date(inv.dueDate).toLocaleDateString("en-AU")}
                      </td>
                      <td className="px-6 py-2.5">
                        <StatusBadge status={isOverdue ? "OVERDUE" : inv.status} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={inv.total} currency={inv.currency} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={outstanding} currency={inv.currency} />
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
