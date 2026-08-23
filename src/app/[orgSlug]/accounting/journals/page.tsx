import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function JournalsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const entries = await LedgerService.listJournalEntries(actor, { limit: 100 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Journals</h1>
          <p className="text-sm text-muted-foreground">{entries.length} entries.</p>
        </div>
        <Button asChild size="sm">
          <Link href={`/${org.slug}/accounting/journals/new`}>
            <Plus /> New journal entry
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No journal entries yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Entry #</th>
                  <th className="px-6 py-2 font-medium">Date</th>
                  <th className="px-6 py-2 font-medium">Memo</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry) => {
                  const total = entry.lines.reduce(
                    (sum, l) => sum.add(Money.of(l.baseDebit, org.baseCurrency)),
                    Money.zero(org.baseCurrency),
                  );
                  return (
                    <tr key={entry.id} className="hover:bg-accent/40">
                      <td className="px-6 py-2.5">
                        <Link
                          href={`/${org.slug}/accounting/journals/${entry.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {entry.entryNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {new Date(entry.postingDate).toLocaleDateString("en-AU")}
                      </td>
                      <td className="max-w-xs truncate px-6 py-2.5 text-muted-foreground">
                        {entry.memo || "—"}
                      </td>
                      <td className="px-6 py-2.5">
                        <StatusBadge status={entry.status} />
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <MoneyDisplay amount={total.toString()} currency={org.baseCurrency} />
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
