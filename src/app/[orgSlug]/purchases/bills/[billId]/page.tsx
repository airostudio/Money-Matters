import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { BillService } from "@/domain/purchases/bill-service";
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
  approveAndPostBillAction,
  deleteDraftBillAction,
  recordSupplierPaymentAction,
  updateBillAction,
  voidBillAction,
} from "../../actions";

export default async function BillDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; billId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const bill = await BillService.get(actor, params.billId);
  if (!bill) notFound();

  const canManage = roleHasPermission(actor.role, "supplier_bill:manage");
  const canPost = roleHasPermission(actor.role, "supplier_bill:post");
  const canVoid = roleHasPermission(actor.role, "supplier_bill:void");
  const canRecordPayment = roleHasPermission(actor.role, "supplier_payment:manage");

  const outstanding = (Number(bill.total) - Number(bill.amountPaid)).toFixed(2);
  const isOverdue = !["DRAFT", "VOID", "PAID"].includes(bill.status) && new Date(bill.dueDate) < new Date();

  const boundUpdate = updateBillAction.bind(null, org.slug, bill.id);
  const boundDelete = deleteDraftBillAction.bind(null, org.slug, bill.id);
  const boundPost = approveAndPostBillAction.bind(null, org.slug, bill.id);
  const boundVoid = voidBillAction.bind(null, org.slug, bill.id);
  const boundRecordPayment = recordSupplierPaymentAction.bind(null, org.slug);
  const paymentAccounts = (await AccountService.list(actor)).filter((a) => a.type === "ASSET");

  if (bill.status === "DRAFT") {
    const [suppliersOnly, both, accounts, taxCodes] = await Promise.all([
      ContactService.list(actor, { kind: "SUPPLIER" }),
      ContactService.list(actor, { kind: "BOTH" }),
      AccountService.list(actor),
      TaxCodeService.list(actor),
    ]);
    const suppliers = [...suppliersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const apAccounts = accounts.filter((a) => a.type === "LIABILITY");
    const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE" || a.type === "ASSET");

    return (
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{bill.billNumber}</h1>
          <StatusBadge status={bill.status} />
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
                  <Label htmlFor="supplierContactId">Supplier</Label>
                  <select
                    id="supplierContactId"
                    name="supplierContactId"
                    required
                    defaultValue={bill.supplierContactId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
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
                    defaultValue={bill.apAccountId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {apAccounts.map((a) => (
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
                    defaultValue={new Date(bill.issueDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dueDate">Due date</Label>
                  <Input
                    id="dueDate"
                    name="dueDate"
                    type="date"
                    defaultValue={new Date(bill.dueDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="supplierReference">Supplier&apos;s invoice number</Label>
                  <Input id="supplierReference" name="supplierReference" defaultValue={bill.supplierReference ?? ""} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="memo">Memo</Label>
                  <Input id="memo" name="memo" defaultValue={bill.memo ?? ""} />
                </div>
              </div>

              <InvoiceLineEditor
                accounts={expenseAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
                initialLines={bill.lines.map((l) => ({
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
            <h1 className="text-2xl font-semibold tracking-tight">{bill.billNumber}</h1>
            <StatusBadge status={isOverdue ? "OVERDUE" : bill.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${org.slug}/purchases/suppliers/${bill.supplierContactId}`} className="hover:underline">
              {bill.supplier.displayName}
            </Link>{" "}
            · Due {new Date(bill.dueDate).toLocaleDateString("en-AU")}
            {bill.supplierReference && <> · Ref {bill.supplierReference}</>}
            {bill.memo && <> · {bill.memo}</>}
          </p>
          {bill.journalEntryId && (
            <p className="mt-1 text-sm">
              Posted as{" "}
              <Link href={`/${org.slug}/accounting/journals/${bill.journalEntryId}`} className="text-primary hover:underline">
                journal entry
              </Link>
              {bill.voidJournalEntryId && (
                <>
                  {" "}
                  · voided via{" "}
                  <Link href={`/${org.slug}/accounting/journals/${bill.voidJournalEntryId}`} className="text-primary hover:underline">
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
              {bill.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">
                    {line.description}
                    <div className="text-xs text-muted-foreground">
                      {line.account.code} · {line.account.name}
                    </div>
                  </td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={bill.currency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    {line.taxCode ? <MoneyDisplay amount={line.taxAmount} currency={bill.currency} /> : "—"}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.lineAmount} currency={bill.currency} />
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
                  <MoneyDisplay amount={bill.subtotal} currency={bill.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right text-muted-foreground">
                  Tax
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={bill.taxTotal} currency={bill.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={bill.total} currency={bill.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-6 py-2 text-right font-medium">
                  Outstanding
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={outstanding} currency={bill.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {bill.allocations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payments applied</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {bill.allocations.map((a) => (
                  <tr key={a.id}>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {new Date(a.createdAt).toLocaleDateString("en-AU")}
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={a.amount} currency={bill.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canRecordPayment && bill.status !== "VOID" && Number(outstanding) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a payment for this bill</CardTitle>
          </CardHeader>
          <form action={boundRecordPayment}>
            <input type="hidden" name="supplierContactId" value={bill.supplierContactId} />
            <input type="hidden" name="returnPath" value={`/${org.slug}/purchases/bills/${bill.id}`} />
            <input type="hidden" name="allocationBillId" value={bill.id} />
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="paymentDate">Date</Label>
                <Input id="paymentDate" name="paymentDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount paid</Label>
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
                <Label htmlFor="paymentAccountId">Pay from</Label>
                <select id="paymentAccountId" name="paymentAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {paymentAccounts.map((a) => (
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

      {canVoid && bill.status !== "VOID" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Void this bill</CardTitle>
          </CardHeader>
          <form action={boundVoid}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" placeholder="e.g. goods returned, billed in error" required />
              </div>
              <Button type="submit" variant="outline">
                Void bill
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
