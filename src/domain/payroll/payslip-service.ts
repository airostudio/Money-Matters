import { and, asc, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import Decimal from "decimal.js";
import { employees, organizations, payRunLines, payRuns } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  PermissionDeniedError,
  assertPermission,
  type Actor,
} from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { maskLast4 } from "./sensitive-data";
import { PayslipNotFoundError } from "./errors";

export const PAYSLIP_DISCLAIMER =
  "PAYG withholding on this payslip uses the annualised-bracket approximation, not the ATO's per-period tables, and " +
  "super is the superannuation guarantee ACCRUED, not proof it has been paid. Prepared for review by a registered tax " +
  "agent or payroll provider; nothing here has been reported to the ATO.";

export interface PayslipSummary {
  lineId: string;
  payRunId: string;
  employeeId: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  grossPay: string;
  netPay: string;
}

export interface PayslipView extends PayslipSummary {
  employerName: string;
  employmentBasis: "SALARY" | "HOURLY";
  payFrequency: string;
  hoursPaid: string;
  paygWithholding: string;
  superGuarantee: string;
  superFundName: string | null;
  paidToAccount: string | null;
  leave: {
    annualAccrued: string;
    personalAccrued: string;
    annualTaken: string;
    personalTaken: string;
    /** Balance immediately after this run posted; null when it was posted before balances were recorded. */
    annualBalanceAfter: string | null;
    personalBalanceAfter: string | null;
  };
  ytd: {
    financialYearStart: string;
    grossPay: string;
    paygWithholding: string;
    superGuarantee: string;
    netPay: string;
  };
  disclaimer: string;
}

/** Australian financial year start (1 July) for a pay date. */
export function financialYearStart(payDate: Date): Date {
  const y = payDate.getUTCFullYear();
  const startYear = payDate.getUTCMonth() >= 6 ? y : y - 1;
  return new Date(Date.UTC(startYear, 6, 1));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function assertHumanPayslipReader(actor: Actor): void {
  assertPermission(actor, "payslip:read");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("payslip:read", actor.role);
}

function canSeeAnyonesPayslip(actor: Actor): boolean {
  return roleHasPermission(actor.role, "employee:manage") && (!actor.grantedPermissions || actor.grantedPermissions.has("employee:manage"));
}

/**
 * Payslips (Phase 8 Slice 3): one per employee per POSTED pay run. HUMAN-only. A member reads only payslips of the
 * employee record linked to their own login (`employees.user_id`); holders of `employee:manage` (payroll managers,
 * owners, administrators) read anyone's. Anything else - including another employee's payslip - is "not found", never
 * "forbidden", so the existence of a payslip does not leak. TFN is never on a payslip; the bank account is masked.
 */
export const PayslipService = {
  /** The actor's own payslips, newest first. Empty when no employee record is linked to their login. */
  async listMine(actor: Actor): Promise<PayslipSummary[]> {
    assertHumanPayslipReader(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ line: payRunLines, run: payRuns, employee: employees })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(
          and(
            eq(payRunLines.organizationId, actor.organizationId),
            eq(employees.userId, actor.userId),
            eq(payRuns.status, "POSTED"),
          ),
        )
        .orderBy(desc(payRuns.payDate));
      return rows.map((r) => summary(r.line, r.run, r.employee));
    });
  },

  /** An employee's payslips for a payroll manager (`employee:manage`). */
  async listForEmployee(actor: Actor, employeeId: string): Promise<PayslipSummary[]> {
    assertHumanPayslipReader(actor);
    if (!canSeeAnyonesPayslip(actor)) throw new PermissionDeniedError("employee:manage", actor.role);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ line: payRunLines, run: payRuns, employee: employees })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(
          and(
            eq(payRunLines.organizationId, actor.organizationId),
            eq(payRunLines.employeeId, employeeId),
            eq(payRuns.status, "POSTED"),
          ),
        )
        .orderBy(desc(payRuns.payDate));
      return rows.map((r) => summary(r.line, r.run, r.employee));
    });
  },

  async get(actor: Actor, lineId: string): Promise<PayslipView> {
    assertHumanPayslipReader(actor);
    const seeAll = canSeeAnyonesPayslip(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ line: payRunLines, run: payRuns, employee: employees })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(and(eq(payRunLines.id, lineId), eq(payRunLines.organizationId, actor.organizationId)));
      if (!row || row.run.status !== "POSTED") throw new PayslipNotFoundError();
      if (!seeAll && row.employee.userId !== actor.userId) throw new PayslipNotFoundError();

      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.organizationId));

      // Year to date: this employee's POSTED lines from 1 July up to and including this run (ties on pay date broken by posting time).
      const fyStart = financialYearStart(row.run.payDate);
      const ytdRows = await tx
        .select({ line: payRunLines })
        .from(payRunLines)
        .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
        .where(
          and(
            eq(payRunLines.organizationId, actor.organizationId),
            eq(payRunLines.employeeId, row.employee.id),
            eq(payRuns.status, "POSTED"),
            gte(payRuns.payDate, fyStart),
            or(
              lt(payRuns.payDate, row.run.payDate),
              and(eq(payRuns.payDate, row.run.payDate), lte(payRuns.postedAt, row.run.postedAt ?? row.run.payDate)),
            ),
          ),
        )
        .orderBy(asc(payRuns.payDate));
      let gross = new Decimal(0);
      let payg = new Decimal(0);
      let sup = new Decimal(0);
      let net = new Decimal(0);
      for (const y of ytdRows) {
        gross = gross.plus(y.line.grossPay);
        payg = payg.plus(y.line.paygWithholding);
        sup = sup.plus(y.line.superGuarantee);
        net = net.plus(y.line.netPay);
      }

      const l = row.line;
      return {
        ...summary(l, row.run, row.employee),
        employerName: org?.name ?? "",
        employmentBasis: row.employee.employmentBasis,
        payFrequency: row.run.payFrequency,
        hoursPaid: l.hoursPaid,
        paygWithholding: l.paygWithholding,
        superGuarantee: l.superGuarantee,
        superFundName: row.employee.superFundName,
        paidToAccount: maskLast4(row.employee.bankAccountNumber),
        leave: {
          annualAccrued: l.annualLeaveAccrued,
          personalAccrued: l.personalLeaveAccrued,
          annualTaken: l.annualLeaveTaken,
          personalTaken: l.personalLeaveTaken,
          annualBalanceAfter: l.annualLeaveBalanceAfter,
          personalBalanceAfter: l.personalLeaveBalanceAfter,
        },
        ytd: {
          financialYearStart: iso(fyStart),
          grossPay: gross.toFixed(4),
          paygWithholding: payg.toFixed(4),
          superGuarantee: sup.toFixed(4),
          netPay: net.toFixed(4),
        },
        disclaimer: PAYSLIP_DISCLAIMER,
      };
    });
  },
};

function summary(
  line: typeof payRunLines.$inferSelect,
  run: typeof payRuns.$inferSelect,
  employee: typeof employees.$inferSelect,
): PayslipSummary {
  return {
    lineId: line.id,
    payRunId: run.id,
    employeeId: employee.id,
    employeeName: employee.name,
    periodStart: iso(run.periodStart),
    periodEnd: iso(run.periodEnd),
    payDate: iso(run.payDate),
    grossPay: line.grossPay,
    netPay: line.netPay,
  };
}
