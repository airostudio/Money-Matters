import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { discardPayRunDraftAction, postPayRunAction } from "../../actions";

export default async function PayRunDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; payRunId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const run = await PayRunService.get(actor, params.payRunId);

  const boundPost = postPayRunAction.bind(null, org.slug, run.id);
  const boundDiscard = discardPayRunDraftAction.bind(null, org.slug, run.id);

  return (
    <div className="space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Pay run: {run.periodStart} – {run.periodEnd}
          </h1>
          <p className="text-sm text-muted-foreground">Pay date {run.payDate} · {run.payFrequency}</p>
        </div>
        <div className="flex gap-2">
          <span
            className={`self-center rounded-full px-3 py-1 text-xs font-medium ${
              run.status === "POSTED" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
            }`}
          >
            {run.status}
          </span>
          {run.status === "DRAFT" ? (
            <>
              <form action={boundDiscard}>
                <Button type="submit" variant="outline" size="sm">
                  Discard draft
                </Button>
              </form>
              <form action={boundPost}>
                <Button type="submit" size="sm">
                  Post pay run
                </Button>
              </form>
            </>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link href={`/${org.slug}/payroll/pay-runs/${run.id}/stp`}>STP-shaped report</Link>
            </Button>
          )}
        </div>
      </div>

      <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">
        PAYG withholding below uses the ATO&apos;s acknowledged annualized-bracket approximation method — expect
        minor rounding differences from the official per-period lookup tables. Have a registered tax agent or
        payroll provider verify this output before relying on it for real payroll.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payslips</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Employee</th>
                <th className="p-3">Rule set</th>
                <th className="p-3 text-right">Hours</th>
                <th className="p-3 text-right">Gross</th>
                <th className="p-3 text-right">PAYG</th>
                <th className="p-3 text-right">Super</th>
                <th className="p-3 text-right">Net</th>
                <th className="p-3 text-right">Annual leave accrued</th>
                <th className="p-3 text-right">Personal leave accrued</th>
              </tr>
            </thead>
            <tbody>
              {run.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{l.employeeName}</td>
                  <td className="p-3 text-muted-foreground">{l.taxRuleSetLabel}</td>
                  <td className="p-3 text-right">{Number(l.hoursPaid).toFixed(2)}</td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.grossPay} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.paygWithholding} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.superGuarantee} currency="AUD" />
                  </td>
                  <td className="p-3 text-right font-medium">
                    <MoneyDisplay amount={l.netPay} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">{Number(l.annualLeaveAccrued).toFixed(4)}</td>
                  <td className="p-3 text-right">{Number(l.personalLeaveAccrued).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="p-3" colSpan={3}>
                  Totals
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.grossPay} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.paygWithholding} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.superGuarantee} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.netPay} currency="AUD" />
                </td>
                <td className="p-3" colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
