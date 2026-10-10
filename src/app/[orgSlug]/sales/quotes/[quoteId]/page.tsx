import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { QuoteService } from "@/domain/sales/quote-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { InvoiceLineEditor } from "@/components/sales/invoice-line-editor";
import {
  acceptQuoteAction,
  convertQuoteToInvoiceAction,
  declineQuoteAction,
  deleteDraftQuoteAction,
  sendQuoteAction,
  updateQuoteAction,
} from "../../actions";

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; quoteId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const quote = await QuoteService.get(actor, params.quoteId);
  if (!quote) notFound();

  const canManage = roleHasPermission(actor.role, "customer_quote:manage");
  const isExpired = quote.status === "SENT" && new Date(quote.expiryDate) < new Date();

  const boundUpdate = updateQuoteAction.bind(null, org.slug, quote.id);
  const boundDelete = deleteDraftQuoteAction.bind(null, org.slug, quote.id);
  const boundSend = sendQuoteAction.bind(null, org.slug, quote.id);
  const boundAccept = acceptQuoteAction.bind(null, org.slug, quote.id);
  const boundDecline = declineQuoteAction.bind(null, org.slug, quote.id);
  const boundConvert = convertQuoteToInvoiceAction.bind(null, org.slug, quote.id);

  if (quote.status === "DRAFT") {
    const [customersOnly, both, accounts, taxCodes] = await Promise.all([
      ContactService.list(actor, { kind: "CUSTOMER" }),
      ContactService.list(actor, { kind: "BOTH" }),
      AccountService.list(actor),
      TaxCodeService.list(actor),
    ]);
    const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

    return (
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{quote.quoteNumber}</h1>
          <StatusBadge status={quote.status} />
        </div>

        {searchParams.error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Edit draft</CardTitle>
          </CardHeader>
          <form action={boundUpdate}>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="customerContactId">Customer</Label>
                  <select
                    id="customerContactId"
                    name="customerContactId"
                    required
                    defaultValue={quote.customerContactId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="issueDate">Issue date</Label>
                  <Input
                    id="issueDate"
                    name="issueDate"
                    type="date"
                    defaultValue={new Date(quote.issueDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="expiryDate">Expires</Label>
                  <Input
                    id="expiryDate"
                    name="expiryDate"
                    type="date"
                    defaultValue={new Date(quote.expiryDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="memo">Memo</Label>
                  <Input id="memo" name="memo" defaultValue={quote.memo ?? ""} />
                </div>
              </div>

              <InvoiceLineEditor
                accounts={revenueAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
                initialLines={quote.lines.map((l) => ({
                  description: l.description,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  accountId: l.accountId,
                  taxCodeId: l.taxCodeId,
                }))}
              />
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              {canManage && (
                <Button type="submit" variant="outline">
                  Save changes
                </Button>
              )}
            </div>
          </form>
        </Card>

        <div className="flex justify-end gap-2">
          {canManage && (
            <form action={boundDelete}>
              <Button type="submit" variant="outline">
                Delete draft
              </Button>
            </form>
          )}
          {canManage && (
            <form action={boundSend}>
              <Button type="submit">Mark as sent</Button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const arAccounts = (await AccountService.list(actor)).filter((a) => a.type === "ASSET" && a.isControlAccount);
  const arAccountFallback = (await AccountService.list(actor)).filter((a) => a.type === "ASSET");
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{quote.quoteNumber}</h1>
            <StatusBadge status={isExpired ? "EXPIRED" : quote.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${org.slug}/sales/customers/${quote.customerContactId}`} className="hover:underline">
              {quote.customer.displayName}
            </Link>{" "}
            · Expires {new Date(quote.expiryDate).toLocaleDateString("en-AU")}
            {quote.memo && <> · {quote.memo}</>}
          </p>
          {quote.status === "DECLINED" && quote.declineReason && (
            <p className="mt-1 text-sm text-destructive">Declined: {quote.declineReason}</p>
          )}
          {quote.convertedInvoiceId && (
            <p className="mt-1 text-sm">
              Converted to{" "}
              <Link href={`/${org.slug}/sales/invoices/${quote.convertedInvoiceId}`} className="text-primary hover:underline">
                invoice
              </Link>
            </p>
          )}
        </div>

        {searchParams.error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Description</th>
                <th className="px-6 py-2 text-right font-medium">Qty</th>
                <th className="px-6 py-2 text-right font-medium">Unit price</th>
                <th className="px-6 py-2 text-right font-medium">Tax</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {quote.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">
                    {line.description}
                    <div className="text-xs text-muted-foreground">
                      {line.account.code} · {line.account.name}
                    </div>
                  </td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={quote.currency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    {line.taxCode ? <MoneyDisplay amount={line.taxAmount} currency={quote.currency} /> : "—"}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.lineAmount} currency={quote.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={4} className="px-6 py-2 text-right text-muted-foreground">
                  Subtotal
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={quote.subtotal} currency={quote.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right text-muted-foreground">
                  Tax
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={quote.taxTotal} currency={quote.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={quote.total} currency={quote.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {canManage && quote.status === "SENT" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record the customer&rsquo;s answer</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <form action={boundAccept}>
              <Button type="submit">Mark accepted</Button>
            </form>
            <form action={boundDecline} className="flex flex-1 items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Decline reason</Label>
                <Input id="reason" name="reason" placeholder="e.g. went with another supplier" />
              </div>
              <Button type="submit" variant="outline">
                Mark declined
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && quote.status === "ACCEPTED" && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">Convert to invoice</CardTitle>
          </CardHeader>
          <form action={boundConvert}>
            <CardContent className="grid grid-cols-2 gap-4">
              <p className="col-span-2 text-sm text-muted-foreground">
                Creates a draft invoice with this quote&rsquo;s customer and lines copied across — nothing is retyped. The
                invoice still needs its own approval and posting.
              </p>
              <div className="space-y-2">
                <Label htmlFor="issueDate">Invoice issue date</Label>
                <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">Invoice due date</Label>
                <Input id="dueDate" name="dueDate" type="date" defaultValue={inThirtyDays} required />
              </div>
              <div className="col-span-2 space-y-2">
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
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Convert to invoice</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
