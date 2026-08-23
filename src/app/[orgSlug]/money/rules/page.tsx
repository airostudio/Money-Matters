import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { BankRuleService } from "@/domain/banking/bank-rule-service";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { setBankRuleActiveAction } from "../actions";
import type { BankRuleCondition } from "@/domain/banking/types";

function describeConditions(conditions: unknown): string {
  const list = conditions as BankRuleCondition[];
  return list
    .map((c) =>
      c.operator === "CONTAINS" ? `description contains "${c.value}"` : `${c.field} ${c.operator.toLowerCase()} ${c.value}`,
    )
    .join(" and ");
}

export default async function BankRulesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const [rules, accounts] = await Promise.all([BankRuleService.list(actor), AccountService.list(actor)]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const canManage = roleHasPermission(actor.role, "bank_rule:manage");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/${org.slug}/money`} className="text-xs text-muted-foreground hover:underline">
            ← Money
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Bank rules</h1>
          <p className="text-sm text-muted-foreground">
            Auto-categorize imported transactions that match a description.
          </p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/money/rules/new`}>
              <Plus /> New rule
            </Link>
          </Button>
        )}
      </div>

      {rules.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No rules yet — imported transactions won&apos;t be auto-categorized until you add one.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Rule</th>
                  <th className="px-6 py-2 font-medium">When</th>
                  <th className="px-6 py-2 font-medium">Categorize to</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  {canManage && <th className="px-6 py-2 font-medium text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rules.map((rule) => {
                  const actions = rule.actions as { categorizedAccountId: string };
                  const account = accountsById.get(actions.categorizedAccountId);
                  return (
                    <tr key={rule.id} className={!rule.isActive ? "opacity-60" : undefined}>
                      <td className="px-6 py-2.5 font-medium">{rule.name}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">{describeConditions(rule.conditions)}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {account ? `${account.code} — ${account.name}` : "—"}
                      </td>
                      <td className="px-6 py-2.5 text-muted-foreground">{rule.isActive ? "Active" : "Inactive"}</td>
                      {canManage && (
                        <td className="px-6 py-2.5 text-right">
                          <form action={setBankRuleActiveAction.bind(null, org.slug, rule.id, !rule.isActive)}>
                            <Button type="submit" variant="ghost" size="sm">
                              {rule.isActive ? "Deactivate" : "Reactivate"}
                            </Button>
                          </form>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
