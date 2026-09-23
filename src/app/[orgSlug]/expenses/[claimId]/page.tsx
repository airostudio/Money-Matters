import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { ExpenseLineEditor } from "@/components/expenses/expense-line-editor";
import {
  approveExpenseClaimAction,
  deleteDraftExpenseClaimAction,
  markReimbursedExpenseClaimAction,
  rejectExpenseClaimAction,
  submitExpenseClaimAction,
  updateExpenseClaimAction,
  voidExpenseClaimAction,
} from "../actions";

export default async function ExpenseClaimDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; claimId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const claim = await ExpenseClaimService.get(actor, params.claimId);
  if (!claim) notFound();

  const canManage = roleHasPermission(actor.role, "expense_claim:manage") && claim.employeeUserId === actor.userId;
  const canApprove = roleHasPermission(actor.role, "expense_claim:approve");

  const boundUpdate = updateExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundDelete = deleteDraftExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundSubmit = submitExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundApprove = approveExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundReject = rejectExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundReimburse = markReimbursedExpenseClaimAction.bind(null, org.slug, claim.id);
  const boundVoid = voidExpenseClaimAction.bind(null, org.slug, claim.id);

  const errorBanner = searchParams.error && (
    <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
  );

  if (claim.status === "DRAFT") {
    const [accounts, taxCodes] = await Promise.all([AccountService.list(actor), TaxCodeService.list(actor)]);
    const payableAccounts = accounts.filter((a) => a.type === "LIABILITY");
    const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");

    return (
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{claim.claimNumber}</h1>
          <StatusBadge status={claim.status} />
        </div>
        {errorBanner}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Edit draft</CardTitle>
          </CardHeader>
          <form action={boundUpdate}>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" name="description" required defaultValue={claim.description} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="claimDate">Date</Label>
                  <Input
                    id="claimDate"
                    name="claimDate"
                    type="date"
                    defaultValue={new Date(claim.claimDate).toISOString().slice(0, 10)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payableAccountId">Payable account</Label>
                  <select
                    id="payableAccountId"
                    name="payableAccountId"
                    required
                    defaultValue={claim.payableAccountId}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {payableAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="memo">Memo</Label>
                  <Input id="memo" name="memo" defaultValue={claim.memo ?? ""} />
                </div>
              </div>

              <ExpenseLineEditor
                accounts={expenseAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
                initialLines={claim.lines.map((l) => ({
                  description: l.description,
                  amount: l.amount,
                  expenseAccountId: l.expenseAccountId,
                  taxCodeId: l.taxCodeId,
                  category: l.category,
                  receiptId: l.receiptId,
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
            <form action={boundSubmit}>
              <Button type="submit">Submit for approval</Button>
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
            <h1 className="text-2xl font-semibold tracking-tight">{claim.claimNumber}</h1>
            <StatusBadge status={claim.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {claim.description} · {new Date(claim.claimDate).toLocaleDateString("en-AU")}
            {claim.memo && <> · {claim.memo}</>}
          </p>
          {claim.status === "REJECTED" && claim.rejectionReason && (
            <p className="mt-1 text-sm text-destructive">Rejected: {claim.rejectionReason}</p>
          )}
        </div>
      </div>
      {errorBanner}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Description</th>
                <th className="px-6 py-2 font-medium">Category</th>
                <th className="px-6 py-2 text-right font-medium">Tax</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {claim.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">
                    {line.description}
                    <div className="text-xs text-muted-foreground">
                      {line.account.code} · {line.account.name}
                    </div>
                  </td>
                  <td className="px-6 py-2.5 text-muted-foreground">{line.category ?? "—"}</td>
                  <td className="px-6 py-2.5 text-right">
                    {line.taxCode ? <MoneyDisplay amount={line.taxAmount} currency={claim.currency} /> : "—"}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.amount} currency={claim.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={3} className="px-6 py-2 text-right text-muted-foreground">
                  Subtotal
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={claim.subtotal} currency={claim.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-6 py-2 text-right text-muted-foreground">
                  Tax
                </td>
                <td className="px-6 py-2 text-right">
                  <MoneyDisplay amount={claim.taxTotal} currency={claim.currency} />
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-6 py-2 text-right font-medium">
                  Total
                </td>
                <td className="px-6 py-2 text-right font-medium">
                  <MoneyDisplay amount={claim.total} currency={claim.currency} />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {canApprove && claim.status === "SUBMITTED" && (
        <div className="flex justify-end gap-2">
          <form action={boundReject}>
            <div className="flex items-center gap-2">
              <Input name="reason" placeholder="Reason for rejection" className="w-64" />
              <Button type="submit" variant="outline">
                Reject
              </Button>
            </div>
          </form>
          <form action={boundApprove}>
            <Button type="submit">Approve &amp; post</Button>
          </form>
        </div>
      )}

      {canApprove && claim.status === "APPROVED" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mark reimbursed</CardTitle>
          </CardHeader>
          <form action={boundReimburse}>
            <CardContent className="grid grid-cols-2 gap-4">
              <ReimbursementAccountField actor={actor} />
              <div className="space-y-2">
                <Label htmlFor="reimbursementDate">Date</Label>
                <Input
                  id="reimbursementDate"
                  name="reimbursementDate"
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  required
                />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="reference">Reference</Label>
                <Input id="reference" name="reference" placeholder="e.g. bank transaction id" />
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="submit">Mark reimbursed</Button>
            </div>
          </form>
        </Card>
      )}

      {canApprove && claim.status === "APPROVED" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Void this claim</CardTitle>
          </CardHeader>
          <form action={boundVoid}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Input id="reason" name="reason" placeholder="e.g. claimed in error" required />
              </div>
              <Button type="submit" variant="outline">
                Void claim
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}

async function ReimbursementAccountField({ actor }: { actor: Parameters<typeof AccountService.list>[0] }) {
  const accounts = await AccountService.list(actor);
  const bankAccounts = accounts.filter((a) => a.type === "ASSET");
  return (
    <div className="space-y-2">
      <Label htmlFor="reimbursementAccountId">Pay from</Label>
      <select
        id="reimbursementAccountId"
        name="reimbursementAccountId"
        required
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        {bankAccounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}
