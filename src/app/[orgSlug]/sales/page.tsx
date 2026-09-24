import Link from "next/link";
import { FileText, Plus, Receipt, RefreshCw, Users } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function SalesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManageInvoices = roleHasPermission(actor.role, "customer_invoice:manage");

  const invoices = await InvoiceService.list(actor);
  const outstanding = invoices.filter((i) => !["DRAFT", "VOID", "PAID"].includes(i.status));
  const overdueCount = outstanding.filter((i) => new Date(i.dueDate) < new Date()).length;
  const draftCount = invoices.filter((i) => i.status === "DRAFT").length;

  const totalOutstanding = outstanding.reduce((sum, i) => {
    const remaining = Number(i.total) - Number(i.amountPaid);
    return sum + remaining;
  }, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
          <p className="text-sm text-muted-foreground">Customers, invoices, and accounts receivable.</p>
        </div>
        {canManageInvoices && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/invoices/new`}>
              <Plus /> New invoice
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding</CardTitle>
          </CardHeader>
          <CardContent>
            <MoneyDisplay amount={totalOutstanding.toFixed(4)} currency={org.baseCurrency} className="text-2xl font-semibold" />
            <p className="mt-1 text-xs text-muted-foreground">{outstanding.length} unpaid invoice(s)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Overdue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{overdueCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">past their due date</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Drafts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{draftCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">not yet posted</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link href={`/${org.slug}/sales/quotes`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <FileText className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Quotes</p>
                <p className="text-xs text-muted-foreground">Send a price, then convert straight to an invoice</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/sales/invoices`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <FileText className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Invoices</p>
                <p className="text-xs text-muted-foreground">Create, post, and track invoices</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/sales/recurring-invoices`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <RefreshCw className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Recurring Invoices</p>
                <p className="text-xs text-muted-foreground">Templates that generate draft invoices for review</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/sales/customers`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <Users className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Customers</p>
                <p className="text-xs text-muted-foreground">Manage customer contacts</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/sales/aged-receivables`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <Receipt className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Aged Receivables</p>
                <p className="text-xs text-muted-foreground">Who owes what, how overdue, and who to chase first</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
