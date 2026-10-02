import Link from "next/link";
import { AlertTriangle, Bot } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { DailyFinanceBriefService } from "@/domain/reporting/daily-finance-brief-service";
import { parseDateParam, formatDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/accounting/metric-card";
import { MoneyDisplay } from "@/components/accounting/money-display";

/**
 * Master spec §73's Daily Finance Brief — see
 * `src/domain/reporting/daily-finance-brief-service.ts` for the full doc
 * comment on what's computed deterministically vs. the optional AI summary,
 * and what's deferred (a scheduled/emailed version — no job-queue
 * infrastructure exists yet).
 */
export default async function DailyBriefPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { asOf?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const asOfDate = parseDateParam(searchParams.asOf) ?? new Date();
  const brief = await DailyFinanceBriefService.generate(actor, asOfDate);
  const orgSlug = params.orgSlug;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Daily Finance Brief</h1>
        <p className="text-sm text-muted-foreground">
          As of {brief.asOf} for {org.name}. Generated on demand — see{" "}
          <Link href={`/${orgSlug}/ai-finance`} className="text-primary hover:underline">
            the AI Financial Controller
          </Link>{" "}
          to ask a follow-up question.
        </p>
      </div>

      {brief.aiSummary && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="flex flex-row items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">AI summary</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{brief.aiSummary}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Cash on hand"
          value={<MoneyDisplay amount={brief.cash.total} currency={brief.currency} />}
          hint={`Across ${brief.cash.accounts.length} account(s)`}
        />
        <MetricCard
          label="Expected in (7 days)"
          value={<MoneyDisplay amount={brief.next7Days.expectedIn} currency={brief.currency} />}
        />
        <MetricCard
          label="Expected out (7 days)"
          value={<MoneyDisplay amount={brief.next7Days.expectedOut} currency={brief.currency} />}
        />
        <MetricCard
          label="Overdue receivables"
          value={<MoneyDisplay amount={brief.overdueReceivables.total} currency={brief.currency} />}
          hint={`${brief.overdueReceivables.count} invoice(s)`}
        />
      </div>

      {brief.callouts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-warning" /> Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {brief.callouts.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Cash by account</CardTitle>
            <Link href={`/${orgSlug}/accounting/trial-balance?asOf=${formatDateParam(asOfDate)}`} className="text-sm text-primary hover:underline">
              Trial Balance
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 p-0">
            {brief.cash.accounts.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No bank accounts linked yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {brief.cash.accounts.map((a) => (
                  <div key={a.bankAccountId} className="flex items-center justify-between px-6 py-3 text-sm">
                    <div>
                      <p className="font-medium">{a.name}</p>
                      {a.institutionName && <p className="text-xs text-muted-foreground">{a.institutionName}</p>}
                    </div>
                    <MoneyDisplay amount={a.balance} currency={brief.currency} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Top collection priorities</CardTitle>
            <Link href={`/${orgSlug}/sales/aged-receivables`} className="text-sm text-primary hover:underline">
              Aged Receivables
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 p-0">
            {brief.overdueReceivables.topPriority.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No overdue invoices.</p>
            ) : (
              <div className="divide-y divide-border">
                {brief.overdueReceivables.topPriority.map((row) => (
                  <Link
                    key={row.invoiceId}
                    href={`/${orgSlug}/sales/invoices/${row.invoiceId}`}
                    className="flex items-center justify-between px-6 py-3 text-sm hover:bg-accent/50"
                  >
                    <div>
                      <p className="font-medium">{row.customerName}</p>
                      <p className="text-xs text-muted-foreground">
                        Invoice {row.invoiceNumber} · {row.daysPastDue} days overdue
                      </p>
                    </div>
                    <MoneyDisplay amount={row.outstanding} currency={brief.currency} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {brief.paymentRunsAwaitingApproval.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Payments awaiting approval</CardTitle>
            <Link href={`/${orgSlug}/purchases/payment-runs`} className="text-sm text-primary hover:underline">
              Payment Runs
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 p-0">
            <div className="divide-y divide-border">
              {brief.paymentRunsAwaitingApproval.map((run) => (
                <Link
                  key={run.id}
                  href={`/${orgSlug}/purchases/payment-runs/${run.id}`}
                  className="flex items-center justify-between px-6 py-3 text-sm hover:bg-accent/50"
                >
                  <span className="font-medium">{run.runNumber}</span>
                  <MoneyDisplay amount={run.totalAmount} currency={run.currency} />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
