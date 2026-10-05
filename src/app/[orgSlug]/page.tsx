import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import { AccountService } from "@/domain/accounts/account-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { DailyFinanceBriefService } from "@/domain/reporting/daily-finance-brief-service";
import { MetricCard } from "@/components/accounting/metric-card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { StatusBadge } from "@/components/accounting/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bot, Sparkles } from "lucide-react";

export default async function OrgHomePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { onboarded?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  // Sequential, not Promise.all: each call opens its own pooled DB
  // connection (see the same note in DailyFinanceBriefService.generate).
  // This page also calls that service below, so keeping concurrency low
  // here matters even more — see the EMAXCONNSESSION incident.
  //
  // Roles with no view of the books at all (EMPLOYEE has none of journal:read /
  // account:read) skip these calls instead of tripping the service's permission
  // refusal on their own home page.
  const canSeeBooks = roleHasPermission(actor.role, "journal:read") && roleHasPermission(actor.role, "account:read");
  const trialBalance = canSeeBooks ? await LedgerService.getTrialBalance(actor) : [];
  const recentEntries = canSeeBooks ? await LedgerService.listJournalEntries(actor, { limit: 5 }) : [];
  const accounts = canSeeBooks ? await AccountService.list(actor) : [];

  const needsOnboarding =
    canSeeBooks && roleHasPermission(actor.role, "onboarding:manage") && !accounts.some((a) => !a.isSystemAccount);

  const canSeeBrief = roleHasPermission(actor.role, "financial_report:read");
  const brief = canSeeBrief ? await DailyFinanceBriefService.generate(actor) : null;

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

      {searchParams.onboarded && (
        <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
          You&apos;re all set up — chart of accounts ready and your first bank account linked.
        </p>
      )}

      {needsOnboarding && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="font-medium">Finish setting up your chart of accounts</p>
                <p className="text-sm text-muted-foreground">
                  {org.name} only has the default starter accounts so far — a couple of minutes will get you a real
                  chart of accounts and your first bank account linked.
                </p>
              </div>
            </div>
            <Button asChild>
              <Link href={`/${org.slug}/onboarding`}>Finish setup</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {!canSeeBooks && (
        <Card>
          <CardContent className="space-y-1 p-6 text-sm">
            <p className="font-medium">Welcome to {org.name}.</p>
            <p className="text-muted-foreground">
              Your role doesn&apos;t include the company&apos;s books, so there are no balances to show here. Use the menu
              on the left to open the areas you have access to.
            </p>
          </CardContent>
        </Card>
      )}

      {canSeeBooks && (
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
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {canSeeBooks && (
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
                No journal entries yet.
                {roleHasPermission(actor.role, "journal:post") && (
                  <>
                    {" "}
                    <Link href={`/${org.slug}/accounting/journals/new`} className="text-primary hover:underline">
                      Post your first one
                    </Link>
                    .
                  </>
                )}
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
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4 text-muted-foreground" /> Daily Finance Brief
            </CardTitle>
            {brief && (
              <Link href={`/${org.slug}/ai-finance/brief`} className="text-sm text-primary hover:underline">
                Full brief
              </Link>
            )}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!brief ? (
              <p className="text-muted-foreground">
                Your role doesn&apos;t have access to financial reports, so the brief isn&apos;t shown here.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cash on hand</span>
                  <MoneyDisplay amount={brief.cash.total} currency={brief.currency} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Overdue receivables</span>
                  <span className={brief.overdueReceivables.count > 0 ? "text-destructive" : undefined}>
                    {brief.overdueReceivables.count > 0 ? (
                      <MoneyDisplay amount={brief.overdueReceivables.total} currency={brief.currency} />
                    ) : (
                      "None"
                    )}
                  </span>
                </div>
                {brief.paymentRunsAwaitingApproval.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Payments to approve</span>
                    <span>{brief.paymentRunsAwaitingApproval.length}</span>
                  </div>
                )}
                <Link href={`/${org.slug}/ai-finance`} className="block pt-1 text-xs text-primary hover:underline">
                  Ask the AI Financial Controller a question →
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
