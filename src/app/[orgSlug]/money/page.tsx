import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function MoneyPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const bankAccounts = await BankAccountService.list(actor);
  const canManage = roleHasPermission(actor.role, "bank_account:manage");

  const withCounts = await Promise.all(
    bankAccounts.map(async (account) => ({
      account,
      unreconciledCount: (await ReconciliationService.listUnreconciled(actor, account.id)).length,
    })),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Money</h1>
          <p className="text-sm text-muted-foreground">
            Bank accounts, statement imports, and reconciliation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/${org.slug}/money/rules`}>Bank rules</Link>
          </Button>
          {canManage && (
            <Button asChild size="sm">
              <Link href={`/${org.slug}/money/new`}>
                <Plus /> Link bank account
              </Link>
            </Button>
          )}
        </div>
      </div>

      {bankAccounts.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No bank accounts linked yet. Link one to a ledger account to start importing statements.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Account</th>
                  <th className="px-6 py-2 font-medium">Institution</th>
                  <th className="px-6 py-2 font-medium">Currency</th>
                  <th className="px-6 py-2 font-medium">Unreconciled</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {withCounts.map(({ account, unreconciledCount }) => (
                  <tr key={account.id} className={!account.isActive ? "opacity-60" : undefined}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/money/${account.id}`} className="font-medium hover:underline">
                        {account.name}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">{account.institutionName ?? "—"}</td>
                    <td className="px-6 py-2.5 text-muted-foreground">{account.currency}</td>
                    <td className="px-6 py-2.5">
                      {unreconciledCount > 0 ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          {unreconciledCount} to review
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">All caught up</span>
                      )}
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {account.isActive ? "Active" : "Inactive"}
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
