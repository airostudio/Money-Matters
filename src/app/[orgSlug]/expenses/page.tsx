import Link from "next/link";
import { Camera, Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { expenseClaimStatusEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

type ExpenseClaimStatus = (typeof expenseClaimStatusEnum.enumValues)[number];

export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { status?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && expenseClaimStatusEnum.enumValues.includes(searchParams.status as ExpenseClaimStatus)
      ? (searchParams.status as ExpenseClaimStatus)
      : undefined;

  const canApprove = roleHasPermission(actor.role, "expense_claim:approve");
  const claims = await ExpenseClaimService.list(actor, { status: statusFilter });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expense claims</h1>
          <p className="text-sm text-muted-foreground">
            {canApprove ? "Every employee's expense claims." : "Your own expense claims."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/${org.slug}/expenses/capture`}>
              <Camera /> Capture receipt
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href={`/${org.slug}/expenses/new`}>
              <Plus /> New claim
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/${org.slug}/expenses`}
          className={`rounded-full px-3 py-1 ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {expenseClaimStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/expenses?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {claims.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No expense claims to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Claim</th>
                  <th className="px-6 py-2 font-medium">Date</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {claims.map((claim) => (
                  <tr key={claim.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/expenses/${claim.id}`} className="font-medium hover:underline">
                        {claim.claimNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground">{claim.description}</div>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {new Date(claim.claimDate).toLocaleDateString("en-AU")}
                    </td>
                    <td className="px-6 py-2.5">
                      <StatusBadge status={claim.status} />
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      <MoneyDisplay amount={claim.total} currency={claim.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
