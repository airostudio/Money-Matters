import Link from "next/link";
import { CreditCard, FileText, Plus, Receipt, RefreshCw, ShoppingCart, Users, Wallet } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { BillService } from "@/domain/purchases/bill-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function PurchasesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManageBills = roleHasPermission(actor.role, "supplier_bill:manage");

  const bills = await BillService.list(actor);
  const outstanding = bills.filter((b) => !["DRAFT", "VOID", "PAID"].includes(b.status));
  const overdueCount = outstanding.filter((b) => new Date(b.dueDate) < new Date()).length;
  const draftCount = bills.filter((b) => b.status === "DRAFT").length;

  const totalOutstanding = outstanding.reduce((sum, b) => {
    const remaining = Number(b.total) - Number(b.amountPaid);
    return sum + remaining;
  }, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
          <p className="text-sm text-muted-foreground">Suppliers, bills, and accounts payable.</p>
        </div>
        {canManageBills && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/bills/new`}>
              <Plus /> New bill
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
            <p className="mt-1 text-xs text-muted-foreground">{outstanding.length} unpaid bill(s)</p>
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href={`/${org.slug}/purchases/bills`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <FileText className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Bills</p>
                <p className="text-xs text-muted-foreground">Create, post, and track supplier bills</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/suppliers`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <Users className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Suppliers</p>
                <p className="text-xs text-muted-foreground">Manage supplier contacts</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/aged-payables`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <Receipt className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Aged Payables</p>
                <p className="text-xs text-muted-foreground">Who you owe, and how overdue</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/purchase-orders`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <ShoppingCart className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Purchase Orders</p>
                <p className="text-xs text-muted-foreground">Order, receive, and three-way match to a bill</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/recurring-bills`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <RefreshCw className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Recurring Bills</p>
                <p className="text-xs text-muted-foreground">Templates for bills that repeat on a schedule</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/supplier-credits`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <CreditCard className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Supplier Credits</p>
                <p className="text-xs text-muted-foreground">Returns and pricing corrections</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/${org.slug}/purchases/payment-runs`}>
          <Card className="h-full transition-colors hover:border-primary">
            <CardContent className="flex items-center gap-3 p-5">
              <Wallet className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Payment Runs</p>
                <p className="text-xs text-muted-foreground">Batch payments with approval segregation</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
