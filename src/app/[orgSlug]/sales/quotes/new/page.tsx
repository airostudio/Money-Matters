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
import { createQuoteAction } from "../../actions";

export default async function NewQuotePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string; customerContactId?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const [customersOnly, both, accounts, taxCodes] = await Promise.all([
    ContactService.list(actor, { kind: "CUSTOMER" }),
    ContactService.list(actor, { kind: "BOTH" }),
    AccountService.list(actor),
    TaxCodeService.list(actor),
  ]);
  const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

  const boundCreate = createQuoteAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (customers.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>You need at least one customer before you can create a quote.</p>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/customers/new`}>Add a customer</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (revenueAccounts.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>You need at least one revenue account in your chart of accounts before you can create a quote.</p>
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
          <CardTitle>New quote</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="customerContactId">Customer</Label>
                <select
                  id="customerContactId"
                  name="customerContactId"
                  required
                  defaultValue={searchParams.customerContactId ?? ""}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="" disabled>
                    Select customer…
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="issueDate">Issue date</Label>
                <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiryDate">Expires</Label>
                <Input id="expiryDate" name="expiryDate" type="date" defaultValue={inThirtyDays} required />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" placeholder="Optional note for this quote" />
              </div>
            </div>

            <InvoiceLineEditor
              accounts={revenueAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
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
