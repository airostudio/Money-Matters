import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { InvoiceService } from "@/domain/sales/invoice-service";
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
  approveAndPostInvoiceAction,
  deleteDraftInvoiceAction,
  recordPaymentAction,
  updateInvoiceAction,
  voidInvoiceAction,
} from "../../actions";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; invoiceId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const invoice = await InvoiceService.get(actor, params.invoiceId);
  if (!invoice) notFound();

  const canManage = roleHasPermission(actor.role, "customer_invoice:manage");
  const canPost = roleHasPermission(actor.role, "customer_invoice:post");
  const canVoid = roleHasPermission(actor.role, "customer_invoice:void");
  const canRecordPayment = roleHasPermission(actor.role, "customer_payment:manage");

  const outstanding = (Number(invoice.total) - Number(invoice.amountPaid)).toFixed(2);
  const isOverdue = !["DRAFT", "VOID", "PAID"].includes(invoice.status) && new Date(invoice.dueDate) < new Date();

  const boundUpdate = updateInvoiceAction.bind(null, org.slug, invoice.id);
  const boundDelete = deleteDraftInvoiceAction.bind(null, org.slug, invoice.id);
  const boundPost = approveAndPostInvoiceAction.bind(null, org.slug, invoice.id);
  const boundVoid = voidInvoiceAction.bind(null, org.slug, invoice.id);
  const boundRecordPayment = recordPaymentAction.bind(null, org.slug);
  const depositAccounts = (await AccountService.list(actor)).filter((a) => a.type === "ASSET");

  if (invoice.status === "DRAFT") {
    const [customersOnly, both, accounts, taxCodes] = await Promise.all([
      ContactService.list(actor, { kind: "CUSTOMER" }),
      ContactService.list(actor, { kind: "BOTH" }),
      AccountService.list(actor),
      TaxCodeService.list(actor),
    ]);
    const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const arAccounts = accounts.filter((a) => a.type === "ASSET");
    const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

    return (
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoiceNumber}</h1>
          <StatusBadge status={invoice.status} />
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
                    defaultValue={invoice.customerContactId}
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
                  <Label htmlFor="arAccountId">Accounts Receivable account</Label>
                  <select
                    id="arAccountId"
                    name="arAccountId"
                    required
                    defaultValue={invoice.arAccountId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {arAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
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
                    defaultValue={new Date(invoice.issueDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dueDate">Due date</Label>
                  <Input
                    id="dueDate"
                    name="dueDate"
                    type="date"
                    defaultValue={new Date(invoice.dueDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="memo">Memo</Label>
                  <Input id="memo" name="memo" defaultValue={invoice.memo ?? ""} />
                </div>
              </div>

              <InvoiceLineEditor
                accounts={revenueAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
                initialLines={invoice.lines.map((l) => ({
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
          {canPost && (
            <form action={boundPost}>
              <Button type="submit">Approve &amp; post</Button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoiceNumber}</h1>
            <StatusBadge status={isOverdue ? "OVERDUE" : invoice.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${org.slug}/sales/customers/${invoice.customerContactId}`} className="hover:underline">
              {invoice.customer.displayName}
            </Link>{" "}
            · Due {new Date(invoice.dueDate).toLocaleDateString("en-AU")}
            {invoice.memo && <> · {invoice.memo}</>}
          </p>
          {invoice.journalEntryId && (
            <p className="mt-1 text-sm">
              Posted as{" "}
              <Link href={`/${org.slug}/accounting/journals/${invoice.journalEntryId}`} className="text-primary hover:underline">
                journal entry
              </Link>
              {invoice.voidJournalEntryId && (
                <>
                  {" "}
                  · voided via{" "}
                  <Link href={`/${org.slug}/accounting/journals/${invoice.voidJournalEntryId}`} className="text-primary hover:underline">
                    reversal
                  </Link>
                </>
              )}
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
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">
                    {line.description}
                    <div className="text-xs text-muted-foreground">
                      {line.account.code} · {line.account.name}
                    </div>
                  </td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={invoice.currency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    {line.taxCode ? <MoneyDisplay amount={line.taxAmount} currency={invoice.currency} /> : "—"}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.lineAmount} currency={invoice.currency} />
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
                  <MoneyDisplay amount={invoice.subtotal} currency={invoice.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right text-muted-foreground">
                  Tax
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={invoice.taxTotal} currency={invoice.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={invoice.total} currency={invoice.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Outstanding
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={outstanding} currency={invoice.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {invoice.allocations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payments applied</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {invoice.allocations.map((a) => (
                  <tr key={a.id}>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {new Date(a.createdAt).toLocaleDateString("en-AU")}
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={a.amount} currency={invoice.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canRecordPayment && invoice.status !== "VOID" && Number(outstanding) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a payment for this invoice</CardTitle>
          </CardHeader>
          <form action={boundRecordPayment}>
            <input type="hidden" name="customerContactId" value={invoice.customerContactId} />
            <input type="hidden" name="returnPath" value={`/${org.slug}/sales/invoices/${invoice.id}`} />
            <input type="hidden" name="allocationInvoiceId" value={invoice.id} />
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="paymentDate">Date</Label>
                <Input id="paymentDate" name="paymentDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount received</Label>
                <Input id="amount" name="amount" inputMode="decimal" defaultValue={outstanding} required />
              </div>
              <input type="hidden" name="allocationAmount" value={outstanding} />
              <div className="space-y-2">
                <Label htmlFor="method">Method</Label>
                <select id="method" name="method" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="depositAccountId">Deposit to</Label>
                <select id="depositAccountId" name="depositAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {depositAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="reference">Reference</Label>
                <Input id="reference" name="reference" placeholder="e.g. bank transaction id" />
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Record payment</Button>
            </div>
          </form>
        </Card>
      )}

      {canVoid && invoice.status !== "VOID" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Void this invoice</CardTitle>
          </CardHeader>
          <form action={boundVoid}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" placeholder="e.g. issued in error, customer cancelled" required />
              </div>
              <Button type="submit" variant="outline">
                Void invoice
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
