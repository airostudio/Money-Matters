import { requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { resolveTrialBalanceColumn } from "@/domain/ledger/trial-balance-presentation";
import { Money } from "@/domain/money/money";
import { Card, CardContent } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function TrialBalancePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { asOf?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const asOfDate = searchParams.asOf ? new Date(searchParams.asOf) : new Date();
  const rows = await LedgerService.getTrialBalance(actor, asOfDate);

  const nonZeroRows = rows
    .filter((r) => r.totalDebit !== "0.0000" || r.totalCredit !== "0.0000")
    .map((row) => resolveTrialBalanceColumn(row, org.baseCurrency));

  const totalDebitColumn = nonZeroRows
    .filter((r) => r.column === "DEBIT")
    .reduce((sum, r) => sum.add(r.magnitude), Money.zero(org.baseCurrency));
  const totalCreditColumn = nonZeroRows
    .filter((r) => r.column === "CREDIT")
    .reduce((sum, r) => sum.add(r.magnitude), Money.zero(org.baseCurrency));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trial Balance</h1>
          <p className="text-sm text-muted-foreground">
            As of {asOfDate.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>
        <form method="get" className="flex items-center gap-2">
          <input
            type="date"
            name="asOf"
            defaultValue={asOfDate.toISOString().slice(0, 10)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </form>
      </div>

      <Card>
        <CardContent className="p-0">
          {nonZeroRows.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No posted activity as of this date.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Account</th>
                  <th className="px-6 py-2 text-right font-medium">Debit</th>
                  <th className="px-6 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {nonZeroRows.map(({ row, column, magnitude }) => (
                  <tr key={row.accountId}>
                    <td className="px-6 py-2.5">
                      <span className="font-mono text-xs text-muted-foreground">{row.code}</span> {row.name}
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      {column === "DEBIT" && (
                        <MoneyDisplay amount={magnitude.toString()} currency={org.baseCurrency} />
                      )}
                    </td>
                    <td className="px-6 py-2.5 text-right">
                      {column === "CREDIT" && (
                        <MoneyDisplay amount={magnitude.toString()} currency={org.baseCurrency} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-border font-medium">
                <tr>
                  <td className="px-6 py-2.5">Total</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={totalDebitColumn.toString()} currency={org.baseCurrency} />
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={totalCreditColumn.toString()} currency={org.baseCurrency} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
