import { PayrollReportService, PAYROLL_REPORT_DISCLAIMER } from "./payroll-report-service";
import type { Actor } from "@/domain/permissions/permission-service";

export const PAYROLL_REPORT_KINDS = ["summary", "payg", "super", "leave"] as const;
export type PayrollReportKind = (typeof PAYROLL_REPORT_KINDS)[number];

export const PAYROLL_REPORT_TITLES: Record<PayrollReportKind, string> = {
  summary: "Payroll summary",
  payg: "PAYG withholding summary",
  super: "Superannuation liability by quarter",
  leave: "Leave liability",
};

function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function csv(rows: string[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Builds one payroll report as CSV (exact decimal strings, never re-derived). Same permissions as the report itself. */
export async function payrollReportCsv(actor: Actor, kind: PayrollReportKind, range: { from: Date; to: Date }): Promise<string> {
  const rows: string[][] = [[PAYROLL_REPORT_TITLES[kind]], [PAYROLL_REPORT_DISCLAIMER], []];
  if (kind === "summary") {
    const r = await PayrollReportService.payrollSummary(actor, range);
    rows.push(["Period", `${r.from} to ${r.to}`], []);
    rows.push(["Employee", "Pay runs", "Gross", "PAYG withheld", "Super guarantee accrued", "Net pay"]);
    for (const l of r.lines) rows.push([l.employeeName, String(l.payRuns), l.grossPay, l.paygWithholding, l.superGuarantee, l.netPay]);
    rows.push(["Total", "", r.totals.grossPay, r.totals.paygWithholding, r.totals.superGuarantee, r.totals.netPay]);
  } else if (kind === "payg") {
    const r = await PayrollReportService.paygSummary(actor, range);
    rows.push(["Period", `${r.from} to ${r.to}`], []);
    rows.push(["Month", "PAYG withheld", "PAYG remitted (recorded)"]);
    for (const m of r.months) rows.push([m.month, m.withheld, m.remitted]);
    rows.push(["Total", r.totalWithheld, r.totalRemittedInRange], []);
    rows.push(["Outstanding now (all posted runs)", "Accrued", "Remitted", "Outstanding"]);
    for (const o of r.outstandingNow) rows.push([o.liabilityAccountId, o.accrued, o.paid, o.outstanding]);
  } else if (kind === "super") {
    const r = await PayrollReportService.superLiabilityByQuarter(actor);
    rows.push(["Quarter starting", "SG accrued"]);
    for (const q of r.quarters) rows.push([q.quarterStart, q.accrued]);
    rows.push(["Total accrued", r.totalAccrued], []);
    rows.push(["Quarter starting", "Remitted (recorded)"]);
    for (const q of r.remittedByQuarter) rows.push([q.quarterStart, q.remitted]);
    rows.push(["Total remitted", r.totalRemitted], []);
    rows.push(["Outstanding now", "Accrued", "Remitted", "Outstanding"]);
    for (const o of r.outstandingNow) rows.push([o.liabilityAccountId, o.accrued, o.paid, o.outstanding]);
  } else {
    const r = await PayrollReportService.leaveLiability(actor);
    rows.push([r.basis], []);
    rows.push(["Employee", "Annual leave hours", "Personal leave hours", "Base hourly rate", "Annual leave estimate"]);
    for (const l of r.rows) rows.push([l.employeeName, l.annualLeaveHours, l.personalLeaveHours, l.baseHourlyRate, l.annualLeaveEstimate]);
    rows.push(["Total", r.totalAnnualLeaveHours, "", "", r.totalAnnualLeaveEstimate]);
  }
  return csv(rows);
}
