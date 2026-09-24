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
import { createRecurringTemplateAction } from "../../actions";

export default async function NewRecurringTemplatePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const [customersOnly, both, accounts, taxCodes] = await Promise.all([
    ContactService.list(actor, { kind: "CUSTOMER" }),
    ContactService.list(actor, { kind: "BOTH" }),
    AccountService.list(actor),
    TaxCodeService.list(actor),
  ]);
  const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const arAccounts = accounts.filter((a) => a.type === "ASSET" && a.isControlAccount);
  const arAccountFallback = accounts.filter((a) => a.type === "ASSET");
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

  const boundCreate = createRecurringTemplateAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);

  if (customers.length === 0 || revenueAccounts.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>You need at least one customer and one revenue account before you can create a recurring template.</p>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/customers/new`}>Add a customer</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>New recurring invoice template</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="name">Template name</Label>
                <Input id="name" name="name" placeholder="e.g. Monthly retainer — Acme Pty Ltd" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerContactId">Customer</Label>
                <select
                  id="customerContactId"
                  name="customerContactId"
                  required
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
                <Label htmlFor="arAccountId">Accounts Receivable account</Label>
                <select
                  id="arAccountId"
                  name="arAccountId"
                  required
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(arAccounts.length > 0 ? arAccounts : arAccountFallback).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="frequency">Frequency</Label>
                <select
                  id="frequency"
                  name="frequency"
                  defaultValue="MONTHLY"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="ANNUALLY">Annually</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="startDate">First invoice date</Label>
                <Input id="startDate" name="startDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End date (optional)</Label>
                <Input id="endDate" name="endDate" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxOccurrences">Stop after N invoices (optional)</Label>
                <Input id="maxOccurrences" name="maxOccurrences" type="number" min={1} placeholder="e.g. 12" />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" placeholder="Optional note copied onto each generated invoice" />
              </div>
            </div>

            <InvoiceLineEditor
              accounts={revenueAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
              taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
            />
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Save template</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
