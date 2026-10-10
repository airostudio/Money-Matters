import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PayslipService } from "@/domain/payroll/payslip-service";
import { PayslipNotFoundError } from "@/domain/payroll/errors";
import { PrintButton } from "@/components/payroll/print-button";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function PayslipPage({ params }: { params: { orgSlug: string; lineId: string } }) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  let slip;
  try {
    slip = await PayslipService.get(actor, params.lineId);
  } catch (error) {
    if (error instanceof PayslipNotFoundError) notFound();
    throw error;
  }
  const hours = (v: string | null) => (v === null ? "not recorded" : `${Number(v).toFixed(2)} h`);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Print: hide the app chrome and let the page flow across sheets. */}
      <style>{`@media print { aside, header { display: none !important; } main { overflow: visible !important; } body > div, .h-screen { height: auto !important; overflow: visible !important; } }`}</style>
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Payslip</h1>
        <PrintButton label="Print payslip" />
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-6 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            <p className="text-lg font-semibold">{slip.employerName}</p>
            <p className="text-muted-foreground">Payslip for {slip.employeeName}</p>
          </div>
          <div className="text-right text-muted-foreground">
            <p>
              Pay period {slip.periodStart} to {slip.periodEnd}
            </p>
            <p>Pay date {slip.payDate}</p>
            <p>{slip.payFrequency.toLowerCase()} · {slip.employmentBasis === "HOURLY" ? `${Number(slip.hoursPaid).toFixed(2)} hours` : "salaried"}</p>
          </div>
        </div>

        <table className="w-full">
          <tbody className="divide-y divide-border">
            <tr>
              <td className="py-2">Gross pay</td>
              <td className="py-2 text-right"><MoneyDisplay amount={slip.grossPay} currency="AUD" /></td>
            </tr>
            <tr>
              <td className="py-2">PAYG withholding</td>
              <td className="py-2 text-right">-<MoneyDisplay amount={slip.paygWithholding} currency="AUD" /></td>
            </tr>
            <tr className="font-semibold">
              <td className="py-2">Net pay</td>
              <td className="py-2 text-right"><MoneyDisplay amount={slip.netPay} currency="AUD" /></td>
            </tr>
            <tr className="text-muted-foreground">
              <td className="py-2">
                Superannuation guarantee accrued{slip.superFundName ? ` (${slip.superFundName})` : ""}
              </td>
              <td className="py-2 text-right"><MoneyDisplay amount={slip.superGuarantee} currency="AUD" /></td>
            </tr>
          </tbody>
        </table>
        {slip.paidToAccount ? <p className="text-xs text-muted-foreground">Paid to account {slip.paidToAccount}</p> : null}

        <div>
          <p className="mb-1 font-medium">Leave</p>
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1"></th>
                <th className="py-1 text-right">Accrued</th>
                <th className="py-1 text-right">Taken</th>
                <th className="py-1 text-right">Balance after this pay</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1">Annual leave</td>
                <td className="py-1 text-right">{hours(slip.leave.annualAccrued)}</td>
                <td className="py-1 text-right">{hours(slip.leave.annualTaken)}</td>
                <td className="py-1 text-right">{hours(slip.leave.annualBalanceAfter)}</td>
              </tr>
              <tr>
                <td className="py-1">Personal / carer&apos;s leave</td>
                <td className="py-1 text-right">{hours(slip.leave.personalAccrued)}</td>
                <td className="py-1 text-right">{hours(slip.leave.personalTaken)}</td>
                <td className="py-1 text-right">{hours(slip.leave.personalBalanceAfter)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-1 font-medium">Year to date (from {slip.ytd.financialYearStart})</p>
          <table className="w-full text-xs">
            <tbody>
              <tr>
                <td className="py-1">Gross</td>
                <td className="py-1 text-right"><MoneyDisplay amount={slip.ytd.grossPay} currency="AUD" /></td>
                <td className="py-1">PAYG</td>
                <td className="py-1 text-right"><MoneyDisplay amount={slip.ytd.paygWithholding} currency="AUD" /></td>
              </tr>
              <tr>
                <td className="py-1">Net</td>
                <td className="py-1 text-right"><MoneyDisplay amount={slip.ytd.netPay} currency="AUD" /></td>
                <td className="py-1">Super accrued</td>
                <td className="py-1 text-right"><MoneyDisplay amount={slip.ytd.superGuarantee} currency="AUD" /></td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">{slip.disclaimer}</p>
      </div>
    </div>
  );
}
