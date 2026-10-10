import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { employees, payRunLines, payRuns, payrollPayments } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { outstandingRemittance } from "./liabilities";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export const PAYROLL_REPORT_DISCLAIMER =
  "Derived only from POSTED pay runs and recorded payments. Requires registered tax agent / payroll provider review; nothing here is reported or lodged with the ATO.";

export interface PayrollSummaryRow {
  employeeId: string;
  employeeName: string;
  payRuns: number;
  grossPay: string;
  paygWithholding: string;
  superGuarantee: string;
  netPay: string;
}

export interface PaygSummary {
  from: string;
  to: string;
  months: Array<{ month: string; withheld: string; remitted: string }>;
  totalWithheld: string;
  totalRemittedInRange: string;
  /** Right now, across all POSTED runs: accrued - remitted per PAYG payable account. */
  outstandingNow: Array<{ liabilityAccountId: string; accrued: string; paid: string; outstanding: string }>;
}

export interface SuperLiabilityQuarter {
  quarterStart: string;
  accrued: string;
}

export interface SuperLiabilityReport {
  quarters: SuperLiabilityQuarter[];
  totalAccrued: string;
  /** Remittances recorded (POSTED) by quarter of payment date. */
  remittedByQuarter: Array<{ quarterStart: string; remitted: string }>;
  totalRemitted: string;
  outstandingNow: Array<{ liabilityAccountId: string; accrued: string; paid: string; outstanding: string }>;
}

export interface LeaveLiabilityRow {
  employeeId: string;
  employeeName: string;
  annualLeaveHours: string;
  personalLeaveHours: string;
  /** Salary / (52 x standard weekly hours), or the hourly rate. A base rate only. */
  baseHourlyRate: string;
  /** annualLeaveHours x baseHourlyRate. Personal leave is shown in hours only (no value is estimated). */
  annualLeaveEstimate: string;
}

export interface LeaveLiabilityReport {
  rows: LeaveLiabilityRow[];
  totalAnnualLeaveHours: string;
  totalAnnualLeaveEstimate: string;
  basis: string;
}

/** Payroll reports (Phase 8 Slice 3): pure aggregation of what is already in the pay run sub-ledger and payments. */
export const PayrollReportService = {
  async payrollSummary(actor: Actor, range: { from: Date; to: Date }) {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({
          employeeId: employees.id,
          employeeName: employees.name,
          runs: sql<number>`count(distinct ${payRuns.id})::int`,
          gross: sql<string>`coalesce(sum(${payRunLines.grossPay}), 0)`,
          payg: sql<string>`coalesce(sum(${payRunLines.paygWithholding}), 0)`,
          superGuarantee: sql<string>`coalesce(sum(${payRunLines.superGuarantee}), 0)`,
          net: sql<string>`coalesce(sum(${payRunLines.netPay}), 0)`,
        })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(
          and(
            eq(payRuns.organizationId, actor.organizationId),
            eq(payRuns.status, "POSTED"),
            gte(payRuns.payDate, range.from),
            lte(payRuns.payDate, range.to),
          ),
        )
        .groupBy(employees.id, employees.name)
        .orderBy(asc(employees.name));
      const lines: PayrollSummaryRow[] = rows.map((r) => ({
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        payRuns: Number(r.runs),
        grossPay: new Decimal(r.gross).toFixed(4),
        paygWithholding: new Decimal(r.payg).toFixed(4),
        superGuarantee: new Decimal(r.superGuarantee).toFixed(4),
        netPay: new Decimal(r.net).toFixed(4),
      }));
      const sumOf = (k: keyof PayrollSummaryRow) => lines.reduce((s, l) => s.plus(l[k] as string), new Decimal(0)).toFixed(4);
      return {
        from: iso(range.from),
        to: iso(range.to),
        lines,
        totals: { grossPay: sumOf("grossPay"), paygWithholding: sumOf("paygWithholding"), superGuarantee: sumOf("superGuarantee"), netPay: sumOf("netPay") },
        disclaimer: PAYROLL_REPORT_DISCLAIMER,
      };
    });
  },

  async paygSummary(actor: Actor, range: { from: Date; to: Date }): Promise<PaygSummary & { disclaimer: string }> {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const withheld = await tx
        .select({
          month: sql<string>`to_char(date_trunc('month', ${payRuns.payDate} at time zone 'UTC'), 'YYYY-MM')`,
          total: sql<string>`coalesce(sum(${payRunLines.paygWithholding}), 0)`,
        })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .where(
          and(
            eq(payRuns.organizationId, actor.organizationId),
            eq(payRuns.status, "POSTED"),
            gte(payRuns.payDate, range.from),
            lte(payRuns.payDate, range.to),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const remitted = await tx
        .select({
          month: sql<string>`to_char(date_trunc('month', ${payrollPayments.paymentDate} at time zone 'UTC'), 'YYYY-MM')`,
          total: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)`,
        })
        .from(payrollPayments)
        .where(
          and(
            eq(payrollPayments.organizationId, actor.organizationId),
            eq(payrollPayments.kind, "PAYG"),
            eq(payrollPayments.status, "POSTED"),
            gte(payrollPayments.paymentDate, range.from),
            lte(payrollPayments.paymentDate, range.to),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const months = new Map<string, { withheld: Decimal; remitted: Decimal }>();
      for (const w of withheld) months.set(w.month, { withheld: new Decimal(w.total), remitted: new Decimal(0) });
      for (const r of remitted) {
        const m = months.get(r.month) ?? { withheld: new Decimal(0), remitted: new Decimal(0) };
        m.remitted = new Decimal(r.total);
        months.set(r.month, m);
      }
      const accounts = await tx
        .selectDistinct({ id: payRuns.paygWithholdingPayableAccountId })
        .from(payRuns)
        .where(and(eq(payRuns.organizationId, actor.organizationId), eq(payRuns.status, "POSTED")));
      const outstandingNow: PaygSummary["outstandingNow"] = [];
      for (const a of accounts) {
        const pos = await outstandingRemittance(tx, actor.organizationId, "PAYG", a.id);
        outstandingNow.push({ liabilityAccountId: a.id, ...pos });
      }
      const sorted = [...months.entries()].sort(([a], [b]) => a.localeCompare(b));
      return {
        from: iso(range.from),
        to: iso(range.to),
        months: sorted.map(([month, v]) => ({ month, withheld: v.withheld.toFixed(4), remitted: v.remitted.toFixed(4) })),
        totalWithheld: sorted.reduce((s, [, v]) => s.plus(v.withheld), new Decimal(0)).toFixed(4),
        totalRemittedInRange: sorted.reduce((s, [, v]) => s.plus(v.remitted), new Decimal(0)).toFixed(4),
        outstandingNow,
        disclaimer: PAYROLL_REPORT_DISCLAIMER,
      };
    });
  },

  /** Superannuation guarantee accrued by calendar quarter of pay date, against remittances recorded. SG due dates are NOT modelled. */
  async superLiabilityByQuarter(actor: Actor): Promise<SuperLiabilityReport & { disclaimer: string }> {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const accrued = await tx
        .select({
          quarter: sql<string>`to_char(date_trunc('quarter', ${payRuns.payDate} at time zone 'UTC'), 'YYYY-MM-DD')`,
          total: sql<string>`coalesce(sum(${payRunLines.superGuarantee}), 0)`,
        })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .where(and(eq(payRuns.organizationId, actor.organizationId), eq(payRuns.status, "POSTED")))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const paid = await tx
        .select({
          quarter: sql<string>`to_char(date_trunc('quarter', ${payrollPayments.paymentDate} at time zone 'UTC'), 'YYYY-MM-DD')`,
          total: sql<string>`coalesce(sum(${payrollPayments.amount}), 0)`,
        })
        .from(payrollPayments)
        .where(
          and(
            eq(payrollPayments.organizationId, actor.organizationId),
            eq(payrollPayments.kind, "SUPER"),
            eq(payrollPayments.status, "POSTED"),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const accounts = await tx
        .selectDistinct({ id: payRuns.superannuationPayableAccountId })
        .from(payRuns)
        .where(and(eq(payRuns.organizationId, actor.organizationId), eq(payRuns.status, "POSTED")));
      const outstandingNow: SuperLiabilityReport["outstandingNow"] = [];
      for (const a of accounts) {
        const pos = await outstandingRemittance(tx, actor.organizationId, "SUPER", a.id);
        outstandingNow.push({ liabilityAccountId: a.id, ...pos });
      }
      return {
        quarters: accrued.map((r) => ({ quarterStart: r.quarter, accrued: new Decimal(r.total).toFixed(4) })),
        totalAccrued: accrued.reduce((s, r) => s.plus(r.total), new Decimal(0)).toFixed(4),
        remittedByQuarter: paid.map((r) => ({ quarterStart: r.quarter, remitted: new Decimal(r.total).toFixed(4) })),
        totalRemitted: paid.reduce((s, r) => s.plus(r.total), new Decimal(0)).toFixed(4),
        outstandingNow,
        disclaimer: PAYROLL_REPORT_DISCLAIMER,
      };
    });
  },

  /** Annual leave owed, estimated at each ACTIVE employee's base hourly rate. No loading, on-costs or award rates are applied. */
  async leaveLiability(actor: Actor): Promise<LeaveLiabilityReport & { disclaimer: string }> {
    assertPermission(actor, "employee:read");
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const emps = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.organizationId, actor.organizationId), eq(employees.status, "ACTIVE")))
        .orderBy(asc(employees.name));
      const rows: LeaveLiabilityRow[] = emps.map((e) => {
        const rate =
          e.employmentBasis === "HOURLY"
            ? new Decimal(e.hourlyRate ?? 0)
            : new Decimal(e.annualSalary ?? 0).dividedBy(new Decimal(52).times(e.standardHoursPerWeek));
        return {
          employeeId: e.id,
          employeeName: e.name,
          annualLeaveHours: new Decimal(e.annualLeaveBalanceHours).toFixed(4),
          personalLeaveHours: new Decimal(e.personalLeaveBalanceHours).toFixed(4),
          baseHourlyRate: rate.toFixed(4),
          annualLeaveEstimate: new Decimal(e.annualLeaveBalanceHours).times(rate).toFixed(4),
        };
      });
      return {
        rows,
        totalAnnualLeaveHours: rows.reduce((s, r) => s.plus(r.annualLeaveHours), new Decimal(0)).toFixed(4),
        totalAnnualLeaveEstimate: rows.reduce((s, r) => s.plus(r.annualLeaveEstimate), new Decimal(0)).toFixed(4),
        basis:
          "Annual leave hours x base hourly rate (annual salary / (52 x standard weekly hours), or the hourly rate). Excludes leave loading, on-costs and award rates; personal leave is shown in hours only and no value is estimated.",
        disclaimer: PAYROLL_REPORT_DISCLAIMER,
      };
    });
  },
};
