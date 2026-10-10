import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { PayrollReportService, PAYROLL_REPORT_DISCLAIMER } from "@/domain/payroll/payroll-report-service";
import { PAYROLL_REPORT_KINDS, PAYROLL_REPORT_TITLES, type PayrollReportKind } from "@/domain/payroll/payroll-report-csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { fiscalYearRange } from "../range";

const TH = "p-3 text-right";

export default async function PayrollReportPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; kind: string };
  searchParams: { from?: string; to?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "payrun:read", org.slug);
  if (denied) return denied;
  if (!(PAYROLL_REPORT_KINDS as readonly string[]).includes(params.kind)) notFound();
  const kind = params.kind as PayrollReportKind;
  const range = fiscalYearRange(searchParams.from, searchParams.to);
  const exportQs = new URLSearchParams();
  if (searchParams.from) exportQs.set("from", searchParams.from);
  if (searchParams.to) exportQs.set("to", searchParams.to);

  let body: React.ReactNode = null;
  if (kind === "summary") {
    const r = await PayrollReportService.payrollSummary(actor, range);
    body = (
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="p-3">Employee</th>
            <th className={TH}>Pay runs</th>
            <th className={TH}>Gross</th>
            <th className={TH}>PAYG</th>
            <th className={TH}>Super accrued</th>
            <th className={TH}>Net</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.employeeId} className="border-b border-border last:border-0">
              <td className="p-3">{l.employeeName}</td>
              <td className="p-3 text-right">{l.payRuns}</td>
              <td className="p-3 text-right"><MoneyDisplay amount={l.grossPay} currency="AUD" /></td>
              <td className="p-3 text-right"><MoneyDisplay amount={l.paygWithholding} currency="AUD" /></td>
              <td className="p-3 text-right"><MoneyDisplay amount={l.superGuarantee} currency="AUD" /></td>
              <td className="p-3 text-right"><MoneyDisplay amount={l.netPay} currency="AUD" /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-medium">
            <td className="p-3" colSpan={2}>Total</td>
            <td className="p-3 text-right"><MoneyDisplay amount={r.totals.grossPay} currency="AUD" /></td>
            <td className="p-3 text-right"><MoneyDisplay amount={r.totals.paygWithholding} currency="AUD" /></td>
            <td className="p-3 text-right"><MoneyDisplay amount={r.totals.superGuarantee} currency="AUD" /></td>
            <td className="p-3 text-right"><MoneyDisplay amount={r.totals.netPay} currency="AUD" /></td>
          </tr>
        </tfoot>
      </table>
    );
  } else if (kind === "payg") {
    const r = await PayrollReportService.paygSummary(actor, range);
    body = (
      <div className="space-y-4">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Month</th>
              <th className={TH}>PAYG withheld</th>
              <th className={TH}>Remitted (recorded)</th>
            </tr>
          </thead>
          <tbody>
            {r.months.map((m) => (
              <tr key={m.month} className="border-b border-border last:border-0">
                <td className="p-3">{m.month}</td>
                <td className="p-3 text-right"><MoneyDisplay amount={m.withheld} currency="AUD" /></td>
                <td className="p-3 text-right"><MoneyDisplay amount={m.remitted} currency="AUD" /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="p-3">Total</td>
              <td className="p-3 text-right"><MoneyDisplay amount={r.totalWithheld} currency="AUD" /></td>
              <td className="p-3 text-right"><MoneyDisplay amount={r.totalRemittedInRange} currency="AUD" /></td>
            </tr>
          </tfoot>
        </table>
        <p className="px-3 pb-3 text-sm">
          Outstanding now: {r.outstandingNow.length === 0 ? "none" : r.outstandingNow.map((o) => o.outstanding).join(", ")}
        </p>
      </div>
    );
  } else if (kind === "super") {
    const r = await PayrollReportService.superLiabilityByQuarter(actor);
    body = (
      <div className="space-y-3">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Calendar quarter starting</th>
              <th className={TH}>SG accrued</th>
              <th className={TH}>Remitted in the quarter (recorded)</th>
            </tr>
          </thead>
          <tbody>
            {[...new Set([...r.quarters.map((q) => q.quarterStart), ...r.remittedByQuarter.map((q) => q.quarterStart)])].sort().map((qs) => (
              <tr key={qs} className="border-b border-border last:border-0">
                <td className="p-3">{qs}</td>
                <td className="p-3 text-right"><MoneyDisplay amount={r.quarters.find((q) => q.quarterStart === qs)?.accrued ?? "0"} currency="AUD" /></td>
                <td className="p-3 text-right"><MoneyDisplay amount={r.remittedByQuarter.find((q) => q.quarterStart === qs)?.remitted ?? "0"} currency="AUD" /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="p-3">Total</td>
              <td className="p-3 text-right"><MoneyDisplay amount={r.totalAccrued} currency="AUD" /></td>
              <td className="p-3 text-right"><MoneyDisplay amount={r.totalRemitted} currency="AUD" /></td>
            </tr>
          </tfoot>
        </table>
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          Calendar quarters by pay date. Super guarantee due dates are not modelled. Outstanding now: {r.outstandingNow.length === 0 ? "none" : r.outstandingNow.map((o) => o.outstanding).join(", ")}.
        </p>
      </div>
    );
  } else {
    const r = await PayrollReportService.leaveLiability(actor);
    body = (
      <div className="space-y-3">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Employee</th>
              <th className={TH}>Annual leave (h)</th>
              <th className={TH}>Personal leave (h)</th>
              <th className={TH}>Base rate</th>
              <th className={TH}>Annual leave estimate</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((l) => (
              <tr key={l.employeeId} className="border-b border-border last:border-0">
                <td className="p-3">{l.employeeName}</td>
                <td className="p-3 text-right">{Number(l.annualLeaveHours).toFixed(2)}</td>
                <td className="p-3 text-right">{Number(l.personalLeaveHours).toFixed(2)}</td>
                <td className="p-3 text-right"><MoneyDisplay amount={l.baseHourlyRate} currency="AUD" /></td>
                <td className="p-3 text-right"><MoneyDisplay amount={l.annualLeaveEstimate} currency="AUD" /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="p-3">Total</td>
              <td className="p-3 text-right">{Number(r.totalAnnualLeaveHours).toFixed(2)}</td>
              <td className="p-3" colSpan={2} />
              <td className="p-3 text-right"><MoneyDisplay amount={r.totalAnnualLeaveEstimate} currency="AUD" /></td>
            </tr>
          </tfoot>
        </table>
        <p className="px-3 pb-3 text-xs text-muted-foreground">{r.basis}</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{PAYROLL_REPORT_TITLES[kind]}</h1>
        <Button asChild size="sm" variant="outline">
          <a href={`/${org.slug}/payroll/reports/${kind}/export?${exportQs.toString()}`}>Export CSV</a>
        </Button>
      </div>
      <nav className="flex flex-wrap gap-3 text-sm">
        {PAYROLL_REPORT_KINDS.map((k) => (
          <Link key={k} href={`/${org.slug}/payroll/reports/${k}`} className={k === kind ? "font-medium underline" : "text-muted-foreground hover:underline"}>
            {PAYROLL_REPORT_TITLES[k]}
          </Link>
        ))}
      </nav>
      {kind === "summary" || kind === "payg" ? (
        <form className="flex flex-wrap items-end gap-2 text-sm" method="get">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">From</span>
            <Input name="from" type="date" defaultValue={searchParams.from ?? range.from.toISOString().slice(0, 10)} className="h-8" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">To</span>
            <Input name="to" type="date" defaultValue={searchParams.to ?? range.to.toISOString().slice(0, 10)} className="h-8" />
          </label>
          <Button type="submit" size="sm">
            Apply
          </Button>
        </form>
      ) : null}
      <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">{PAYROLL_REPORT_DISCLAIMER}</p>
      <Card>
        <CardContent className="p-0">{body}</CardContent>
      </Card>
    </div>
  );
}
