import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { sourceDocumentHref, SOURCE_DOCUMENT_LABEL } from "@/domain/reporting/source-document-links";
import { currentMonthRange, formatDateParam, parseDateParam } from "@/domain/reporting/period-presets";
import { Card, CardContent } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { StatusBadge } from "@/components/accounting/status-badge";

/**
 * Master spec §32: "Every report must allow drill-down. Click: Revenue →
 * Account → Transaction → Invoice → Source Document." This page is the
 * "Account → Transaction" hop every financial statement's line amounts link
 * to; `sourceDocumentHref` (shared with the Journal Entry detail page) is
 * the final "→ Source Document" hop.
 */

export default async function AccountTransactionsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; accountId: string };
  searchParams: { from?: string; to?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);

  const account = await ReportingService.getAccount(actor, params.accountId);
  if (!account) notFound();

  const defaultRange = currentMonthRange();
  const from = parseDateParam(searchParams.from) ?? new Date("1970-01-01");
  const to = parseDateParam(searchParams.to) ?? defaultRange.to;

  const transactions = await ReportingService.getAccountTransactions(actor, params.accountId, { from, to });

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/accounting/chart-of-accounts`} className="hover:underline">
            Chart of Accounts
          </Link>{" "}
          / Account transactions
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="font-mono text-base text-muted-foreground">{account.code}</span> {account.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {from.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })} –{" "}
          {to.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })}
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            type="date"
            id="from"
            name="from"
            defaultValue={formatDateParam(from)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            type="date"
            id="to"
            name="to"
            defaultValue={formatDateParam(to)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
          Update
        </button>
      </form>

      <Card>
        <CardContent className="p-0">
          {transactions.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No posted transactions in this range.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Date</th>
                  <th className="px-6 py-2 font-medium">Journal Entry</th>
                  <th className="px-6 py-2 font-medium">Memo</th>
                  <th className="px-6 py-2 font-medium">Source Document</th>
                  <th className="px-6 py-2 text-right font-medium">Debit</th>
                  <th className="px-6 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {transactions.map((txn) => {
                  const href = txn.sourceDocument ? sourceDocumentHref(org.slug, txn.sourceDocument) : null;
                  return (
                    <tr key={txn.journalLineId}>
                      <td className="px-6 py-2.5">
                        {new Date(txn.postingDate).toLocaleDateString("en-AU", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="px-6 py-2.5">
                        <Link
                          href={`/${org.slug}/accounting/journals/${txn.journalEntryId}`}
                          className="text-primary hover:underline"
                        >
                          {txn.entryNumber}
                        </Link>{" "}
                        {txn.status === "REVERSED" && <StatusBadge status="REVERSED" />}
                      </td>
                      <td className="px-6 py-2.5 text-muted-foreground">{txn.memo || "—"}</td>
                      <td className="px-6 py-2.5">
                        {txn.sourceDocument ? (
                          href ? (
                            <Link href={href} className="text-primary hover:underline">
                              {SOURCE_DOCUMENT_LABEL[txn.sourceDocument.type]} {txn.sourceDocument.label}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">
                              {SOURCE_DOCUMENT_LABEL[txn.sourceDocument.type]} {txn.sourceDocument.label}
                            </span>
                          )
                        ) : (
                          <span className="text-muted-foreground">Manual journal</span>
                        )}
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        {txn.debit !== "0.0000" && <MoneyDisplay amount={txn.debit} currency={account.currency} />}
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        {txn.credit !== "0.0000" && <MoneyDisplay amount={txn.credit} currency={account.currency} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
