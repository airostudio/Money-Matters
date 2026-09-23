import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { ReceiptService } from "@/domain/documents/receipt-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExpenseLineEditor } from "@/components/expenses/expense-line-editor";
import { createExpenseClaimAction } from "../actions";

export default async function NewExpenseClaimPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string; receiptId?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const [accounts, taxCodes] = await Promise.all([AccountService.list(actor), TaxCodeService.list(actor)]);
  const payableAccounts = accounts.filter((a) => a.type === "LIABILITY");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");

  const canPickEmployee = roleHasPermission(actor.role, "membership:manage");
  const members = canPickEmployee ? await OrganizationService.listMembers(actor) : [];

  const receipt = searchParams.receiptId ? await ReceiptService.get(actor, searchParams.receiptId) : null;
  const extraction =
    receipt?.extractedData && typeof receipt.extractedData === "object"
      ? (receipt.extractedData as {
          supplierName: string | null;
          date: string | null;
          total: string | null;
          suggestedCategory: string | null;
          reasoning: string;
          confidence: number;
        })
      : null;

  const boundCreate = createExpenseClaimAction.bind(null, org.slug);
  const today = new Date().toISOString().slice(0, 10);

  if (expenseAccounts.length === 0 || payableAccounts.length === 0) {
    return (
      <Card className="max-w-lg">
        <CardContent className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            You need at least one expense account and one liability account (e.g. &quot;Employee Reimbursements
            Payable&quot;) before you can create an expense claim.
          </p>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/accounting/chart-of-accounts/new`}>Add an account</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>New expense claim</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}

            {receipt && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                <p className="font-medium">Receipt attached: {receipt.fileName}</p>
                {extraction ? (
                  <p className="text-muted-foreground">
                    AI pre-filled this draft from the receipt ({Math.round(extraction.confidence * 100)}% confidence)
                    — {extraction.reasoning} Review every field below before saving.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Could not extract data automatically — fill in the details below manually.
                  </p>
                )}
              </div>
            )}

            {canPickEmployee && (
              <div className="space-y-2">
                <Label htmlFor="employeeUserId">Employee</Label>
                <select
                  id="employeeUserId"
                  name="employeeUserId"
                  defaultValue={actor.userId}
                  className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
                >
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  name="description"
                  required
                  defaultValue={extraction?.supplierName ?? ""}
                  placeholder="e.g. Client lunch, Sydney"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="claimDate">Date</Label>
                <Input id="claimDate" name="claimDate" type="date" defaultValue={extraction?.date ?? today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payableAccountId">Payable account</Label>
                <select
                  id="payableAccountId"
                  name="payableAccountId"
                  required
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
                <Input id="memo" name="memo" placeholder="Optional note for this claim" />
              </div>
            </div>

            <ExpenseLineEditor
              accounts={expenseAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
              taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
              initialLines={
                receipt
                  ? [
                      {
                        description: extraction?.supplierName ?? receipt.fileName,
                        amount: extraction?.total ?? "",
                        expenseAccountId: "",
                        taxCodeId: null,
                        category: extraction?.suggestedCategory ?? "",
                        receiptId: receipt.id,
                      },
                    ]
                  : undefined
              }
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
