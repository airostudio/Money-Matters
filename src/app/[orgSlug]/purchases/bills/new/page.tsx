import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { ContactService } from "@/domain/contacts/contact-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceLineEditor } from "@/components/sales/invoice-line-editor";
import { createBillAction } from "../../actions";

export default async function NewBillPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string; supplierContactId?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const [suppliersOnly, both, accounts, taxCodes] = await Promise.all([
    ContactService.list(actor, { kind: "SUPPLIER" }),
    ContactService.list(actor, { kind: "BOTH" }),
    AccountService.list(actor),
    TaxCodeService.list(actor),
  ]);
  const suppliers = [...suppliersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const apAccounts = accounts.filter((a) => a.type === "LIABILITY" && a.isControlAccount);
  const apAccountFallback = accounts.filter((a) => a.type === "LIABILITY");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE" || a.type === "ASSET");

  const boundCreate = createBillAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (suppliers.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>You need at least one supplier before you can create a bill.</p>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/purchases/suppliers/new`}>Add a supplier</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (expenseAccounts.length === 0 || (apAccounts.length === 0 && apAccountFallback.length === 0)) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>You need at least one expense/asset account and one Accounts Payable liability account before you can create a bill.</p>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/accounting/chart-of-accounts/new`}>Add an account</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>New bill</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="supplierContactId">Supplier</Label>
                <select
                  id="supplierContactId"
                  name="supplierContactId"
                  required
                  defaultValue={searchParams.supplierContactId ?? ""}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="" disabled>
                    Select supplier…
                  </option>
                  {suppliers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="apAccountId">Accounts Payable account</Label>
                <select
                  id="apAccountId"
                  name="apAccountId"
                  required
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(apAccounts.length > 0 ? apAccounts : apAccountFallback).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="issueDate">Issue date</Label>
                <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">Due date</Label>
                <Input id="dueDate" name="dueDate" type="date" defaultValue={inThirtyDays} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="supplierReference">Supplier&apos;s invoice number</Label>
                <Input id="supplierReference" name="supplierReference" placeholder="Optional — their reference" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" placeholder="Optional note for this bill" />
              </div>
            </div>

            <InvoiceLineEditor
              accounts={expenseAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
              taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
            />
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Save draft</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
