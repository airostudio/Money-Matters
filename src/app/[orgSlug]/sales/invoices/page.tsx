import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { AutoExecutionService } from "@/domain/ai-controller/auto-execution-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { invoiceStatusEnum } from "@/db/schema";
import { INVOICE_FILTERS, matchesInvoiceFilter, parseInvoiceFilter } from "@/domain/sales/invoice-filters";
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
  searchParams: { status?: string; filter?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && invoiceStatusEnum.enumValues.includes(searchParams.status as InvoiceStatus)
      ? (searchParams.status as InvoiceStatus)
      : undefined;

  const quickFilter = parseInvoiceFilter(searchParams.filter);
  const now = new Date();

  const allInvoices = await InvoiceService.list(actor, { status: statusFilter });
  // "Unpaid" / "Overdue" are views over the same list (no extra query): see src/domain/sales/invoice-filters.ts.
  const invoices = quickFilter ? allInvoices.filter((inv) => matchesInvoiceFilter(quickFilter, inv, now)) : allInvoices;
  const aiAutoInvoiceIds = await AutoExecutionService.listAutoExecutedEntityIds(org.id, "Invoice");
  const canManage = roleHasPermission(actor.role, "customer_invoice:manage");

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
          className={`rounded-full px-3 py-1 ${!statusFilter && !quickFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {INVOICE_FILTERS.map((f) => (
          <Link
            key={f}
            href={`/${org.slug}/sales/invoices?filter=${f}`}
            className={`rounded-full px-3 py-1 capitalize ${quickFilter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {f}
          </Link>
        ))}
        {invoiceStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/sales/invoices?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s && !quickFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {invoices.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">{quickFilter ? `No ${quickFilter} invoices.` : "No invoices to show."}</CardContent>
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
                        {aiAutoInvoiceIds.has(inv.id) && (
                          <span
                            className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                            title="Auto-created by the AI Financial Controller under this organization's autonomy policy — see Settings"
                          >
                            AI auto
                          </span>
                        )}
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
