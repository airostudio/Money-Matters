import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import { MetricCard } from "@/components/accounting/metric-card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { StatusBadge } from "@/components/accounting/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot } from "lucide-react";

export default async function OrgHomePage({ params }: { params: { orgSlug: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  const [trialBalance, recentEntries] = await Promise.all([
    LedgerService.getTrialBalance(actor),
    LedgerService.listJournalEntries(actor, { limit: 5 }),
  ]);

  const sum = (types: string[]) =>
    trialBalance
      .filter((r) => types.includes(r.type))
      .reduce((acc, r) => acc.add(Money.of(r.balance, org.baseCurrency)), Money.zero(org.baseCurrency));

  const assets = sum(["ASSET"]);
  const liabilities = sum(["LIABILITY"]);
  const equity = sum(["EQUITY"]);
  const revenue = sum(["REVENUE"]);
  const expenses = sum(["EXPENSE"]);
  const netProfit = revenue.subtract(expenses);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Good to see you.</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s where {org.name} stands right now.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Assets" value={<MoneyDisplay amount={assets.toString()} currency={org.baseCurrency} />} />
        <MetricCard
          label="Liabilities"
          value={<MoneyDisplay amount={liabilities.toString()} currency={org.baseCurrency} />}
        />
        <MetricCard label="Equity" value={<MoneyDisplay amount={equity.toString()} currency={org.baseCurrency} />} />
        <MetricCard
          label="Net profit (all-time)"
          value={<MoneyDisplay amount={netProfit.toString()} currency={org.baseCurrency} showSign />}
          hint={`Revenue ${revenue.toString()} − Expenses ${expenses.toString()}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent journal entries</CardTitle>
            <Link href={`/${org.slug}/accounting/journals`} className="text-sm text-primary hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {recentEntries.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No journal entries yet.{" "}
                <Link href={`/${org.slug}/accounting/journals/new`} className="text-primary hover:underline">
                  Post your first one
                </Link>
                .
              </p>
            ) : (
              <div className="divide-y divide-border">
                {recentEntries.map((entry) => (
                  <Link
                    key={entry.id}
                    href={`/${org.slug}/accounting/journals/${entry.id}`}
                    className="flex items-center justify-between px-6 py-3 text-sm hover:bg-accent/50"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{entry.entryNumber}</p>
                      <p className="truncate text-muted-foreground">
                        {entry.memo || "No memo"} · {new Date(entry.postingDate).toLocaleDateString("en-AU")}
                      </p>
                    </div>
                    <StatusBadge status={entry.status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4 text-muted-foreground" /> AI Financial Controller
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Anomaly detection, daily finance briefs, and the AI Financial Controller land in Phase 6 (see{" "}
            <span className="font-mono text-xs">docs/roadmap.md</span>). Nothing here is faked in the meantime.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
