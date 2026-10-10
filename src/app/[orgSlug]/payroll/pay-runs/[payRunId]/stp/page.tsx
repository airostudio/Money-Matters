import { requireOrgAndActor } from "@/lib/session";
import { StpReportService } from "@/domain/payroll/stp-report-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function StpReportPage({ params }: { params: { orgSlug: string; payRunId: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const report = await StpReportService.forPayRun(actor, params.payRunId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">STP-shaped report</h1>
        <p className="mt-1 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          NOT SUBMITTED TO THE ATO. This page shows the data a Single Touch Payroll (STP) Phase 2 submission would
          contain for pay date {report.payDate} — gross by income type, PAYG withheld, and the superannuation
          liability — to prove the data model captures what real STP reporting needs. Real lodgment requires ATO
          digital-service credentials this environment does not have.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per employee</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Employee</th>
                <th className="p-3">Income type</th>
                <th className="p-3 text-right">Gross payments</th>
                <th className="p-3 text-right">PAYG withheld</th>
                <th className="p-3 text-right">Super liability</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.employeeId} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{l.employeeName}</td>
                  <td className="p-3 text-muted-foreground">{l.incomeType}</td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.grossPayments} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.paygWithheld} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.superannuationLiability} currency="AUD" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="p-3" colSpan={2}>
                  Totals
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={report.totals.grossPayments} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={report.totals.paygWithheld} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={report.totals.superannuationLiability} currency="AUD" />
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
