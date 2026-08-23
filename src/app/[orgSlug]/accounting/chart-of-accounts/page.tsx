import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { setAccountActiveAction } from "./actions";

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  EXPENSE: "Expenses",
};

export default async function ChartOfAccountsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { includeInactive?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const includeInactive = searchParams.includeInactive === "1";
  const accounts = await AccountService.list(actor, { includeInactive });
  const canManage = roleHasPermission(actor.role, "account:manage");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chart of Accounts</h1>
          <p className="text-sm text-muted-foreground">{accounts.length} accounts in {org.baseCurrency}.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link
              href={`?includeInactive=${includeInactive ? "0" : "1"}`}
              scroll={false}
            >
              {includeInactive ? "Hide inactive" : "Show inactive"}
            </Link>
          </Button>
          {canManage && (
            <Button asChild size="sm">
              <Link href={`/${org.slug}/accounting/chart-of-accounts/new`}>
                <Plus /> New account
              </Link>
            </Button>
          )}
        </div>
      </div>

      {TYPE_ORDER.map((type) => {
        const rows = accounts.filter((a) => a.type === type);
        if (rows.length === 0) return null;

        return (
          <Card key={type}>
            <div className="border-b border-border px-6 py-3">
              <h2 className="text-sm font-semibold">{TYPE_LABEL[type]}</h2>
            </div>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-6 py-2 font-medium">Code</th>
                    <th className="px-6 py-2 font-medium">Name</th>
                    <th className="px-6 py-2 font-medium">Sub-type</th>
                    <th className="px-6 py-2 font-medium">Status</th>
                    {canManage && <th className="px-6 py-2 font-medium text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((account) => (
                    <tr key={account.id} className={!account.isActive ? "opacity-60" : undefined}>
                      <td className="px-6 py-2.5 font-mono text-xs">{account.code}</td>
                      <td className="px-6 py-2.5">
                        {account.name}
                        {account.isSystemAccount && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            System
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-2.5 text-muted-foreground">{account.subType ?? "—"}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {account.isActive ? "Active" : "Inactive"}
                      </td>
                      {canManage && (
                        <td className="px-6 py-2.5 text-right">
                          <form
                            action={setAccountActiveAction.bind(
                              null,
                              org.slug,
                              account.id,
                              !account.isActive,
                            )}
                          >
                            <Button type="submit" variant="ghost" size="sm">
                              {account.isActive ? "Deactivate" : "Reactivate"}
                            </Button>
                          </form>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
