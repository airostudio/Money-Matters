import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function PayRunsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const runs = await PayRunService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pay Runs</h1>
          <p className="text-sm text-muted-foreground">
            On-demand payroll runs. PAYG withholding uses the ATO&apos;s acknowledged annualized-bracket
            approximation method — a registered tax agent or payroll provider should verify output against real ATO
            tables before this is used for real payroll.
          </p>
        </div>
        <Can role={actor.role} permission="payrun:manage">
          <Button asChild size="sm">
            <Link href={`/${org.slug}/payroll/pay-runs/new`}>
              <Plus /> New pay run
            </Link>
          </Button>
        </Can>
      </div>

      <Card>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No pay runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Period</th>
                  <th className="p-3">Pay date</th>
                  <th className="p-3">Frequency</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Gross</th>
                  <th className="p-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/payroll/pay-runs/${r.id}`} className="font-medium hover:underline">
                        {r.periodStart} – {r.periodEnd}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">{r.payDate}</td>
                    <td className="p-3 text-muted-foreground">{r.payFrequency}</td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          r.status === "POSTED" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={r.totals.grossPay} currency="AUD" />
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={r.totals.netPay} currency="AUD" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
