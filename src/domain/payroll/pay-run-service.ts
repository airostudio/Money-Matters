import { and, asc, eq, gte, lt, lte, sum } from "drizzle-orm";
import Decimal from "decimal.js";
import { employees, payRunLines, payRuns, payrollTaxRuleSets, timesheetEntries } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import { TaxRuleService } from "./tax-rule-service";
import { calculatePaygWithholding } from "./payg-calculations";
import { calculateSuperGuarantee, sgQuarterStart } from "./super-calculations";
import { calculateLeaveAccrual } from "./leave-calculations";
import { loadEmployeeOr404 } from "./employee-service";
import {
  DuplicatePayRunPeriodError,
  InvalidPayRunError,
  PayRunNotDraftError,
  PayRunNotFoundError,
} from "./errors";
import type { CreatePayRunInput, PayRunLineView, PayRunView } from "./types";

const AU_JURISDICTION = "AU";

export async function loadPayRunOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(payRuns)
    .where(and(eq(payRuns.id, id), eq(payRuns.organizationId, organizationId)));
  if (!row) throw new PayRunNotFoundError(id);
  return row;
}

async function sumQuarterToDateOteBefore(
  tx: TenantDb,
  organizationId: string,
  employeeId: string,
  payDate: Date,
): Promise<string> {
  const quarterStart = sgQuarterStart(payDate);
  const quarterEnd = new Date(Date.UTC(quarterStart.getUTCFullYear(), quarterStart.getUTCMonth() + 3, 1));

  const rows = await tx
    .select({ total: sum(payRunLines.ordinaryTimeEarnings) })
    .from(payRunLines)
    .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
    .where(
      and(
        eq(payRunLines.organizationId, organizationId),
        eq(payRunLines.employeeId, employeeId),
        eq(payRuns.status, "POSTED"),
        gte(payRuns.payDate, quarterStart),
        lt(payRuns.payDate, quarterEnd),
        lt(payRuns.payDate, payDate),
      ),
    );
  return rows[0]?.total ?? "0";
}

async function sumApprovedTimesheetHours(
  tx: TenantDb,
  organizationId: string,
  employeeUserId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  const rows = await tx
    .select({ total: sum(timesheetEntries.hours) })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.organizationId, organizationId),
        eq(timesheetEntries.employeeUserId, employeeUserId),
        eq(timesheetEntries.status, "APPROVED"),
        gte(timesheetEntries.entryDate, periodStart),
        lte(timesheetEntries.entryDate, periodEnd),
      ),
    );
  return rows[0]?.total ?? "0";
}

export interface PayRunAccountWiring {
  wagesExpenseAccountId: string;
  superannuationExpenseAccountId: string;
  paygWithholdingPayableAccountId: string;
  superannuationPayableAccountId: string;
  netWagesPayableAccountId: string;
}

/**
 * The on-demand "run payroll for period X" action (master spec §8) — the
 * payroll mirror of `RecurringInvoiceService.generateDue`/
 * `DepreciationService.runForPeriod`: human-triggered, never scheduled (no
 * job queue exists in this codebase — see docs/roadmap.md).
 *
 * **DRAFT then POST, like a bill/invoice, not depreciation's single-step
 * run**: `create()` computes and stores every `pay_run_lines` row (gross,
 * PAYG, super, leave accrual) for review, but posts nothing and touches no
 * employee's leave balance yet. `post()` is the one-way, terminal step that
 * posts the combined journal AND applies the accrued leave to each
 * employee's running balance — so a DRAFT a payroll manager decides was
 * wrong (bad hours, wrong employee set) can simply be discarded via
 * `discardDraft()` with nothing to unwind, exactly the same "prepare, then
 * a separate irreversible step" discipline `PaymentRunService` already
 * uses for supplier payments.
 *
 * **Immutable once POSTED**: correcting a posted pay run is a reversing
 * journal plus a new, correct pay run — never an edit to this row or its
 * lines, the same discipline every other posted entry in this codebase
 * follows (`PostingService.reverseEntry`, `FixedAssetService.
 * disposeAsset`'s doc comment, etc).
 */
export const PayRunService = {
  async list(actor: Actor): Promise<PayRunView[]> {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const runs = await tx
        .select()
        .from(payRuns)
        .where(eq(payRuns.organizationId, actor.organizationId))
        .orderBy(asc(payRuns.periodStart));
      return Promise.all(runs.map((r) => buildPayRunView(tx, actor.organizationId, r)));
    });
  },

  async get(actor: Actor, id: string): Promise<PayRunView> {
    assertPermission(actor, "payrun:read");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, id);
      return buildPayRunView(tx, actor.organizationId, run);
    });
  },

  /**
   * Computes and stores every `pay_run_lines` row as a DRAFT — no journal
   * posted, no leave balance touched yet (see this module's doc comment).
   * Refuses a second DRAFT/POSTED run that already has a line for the same
   * employee within an overlapping [periodStart, periodEnd] window — the
   * structural half of "never silently double-pay the same period" (the
   * other half being that correcting a POSTED run is a reversing journal,
   * never an edit).
   */
  async create(actor: Actor, input: CreatePayRunInput, accounts: PayRunAccountWiring): Promise<PayRunView> {
    assertPermission(actor, "payrun:manage");
    if (input.periodEnd < input.periodStart) throw new InvalidPayRunError("periodEnd must not be before periodStart.");
    if (input.employeeIds.length === 0) throw new InvalidPayRunError("Select at least one employee.");

    return withTenant(actor.organizationId, async (tx) => {
      const [created] = await tx
        .insert(payRuns)
        .values({
          organizationId: actor.organizationId,
          payFrequency: input.payFrequency,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payDate: input.payDate,
          status: "DRAFT",
          wagesExpenseAccountId: accounts.wagesExpenseAccountId,
          superannuationExpenseAccountId: accounts.superannuationExpenseAccountId,
          paygWithholdingPayableAccountId: accounts.paygWithholdingPayableAccountId,
          superannuationPayableAccountId: accounts.superannuationPayableAccountId,
          netWagesPayableAccountId: accounts.netWagesPayableAccountId,
          createdById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create pay run.");

      const ruleSet = await TaxRuleService.resolve(AU_JURISDICTION, input.payDate);
      const currency = "AUD";

      for (const employeeId of input.employeeIds) {
        const employee = await loadEmployeeOr404(tx, actor.organizationId, employeeId);
        if (employee.status !== "ACTIVE") {
          throw new InvalidPayRunError(`Employee "${employee.name}" is not ACTIVE and cannot be paid.`);
        }
        if (employee.payFrequency !== input.payFrequency) {
          throw new InvalidPayRunError(
            `Employee "${employee.name}" is paid ${employee.payFrequency}, not ${input.payFrequency} — select employees on the same pay frequency.`,
          );
        }

        const [existingLine] = await tx
          .select({ id: payRunLines.id })
          .from(payRunLines)
          .innerJoin(payRuns, eq(payRuns.id, payRunLines.payRunId))
          .where(
            and(
              eq(payRunLines.organizationId, actor.organizationId),
              eq(payRunLines.employeeId, employeeId),
              gte(payRuns.periodEnd, input.periodStart),
              lte(payRuns.periodStart, input.periodEnd),
            ),
          );
        if (existingLine) throw new DuplicatePayRunPeriodError(employee.name);

        let hoursPaid = "0";
        let grossPay: string;

        if (employee.employmentBasis === "SALARY") {
          const periodsPerYear = { WEEKLY: 52, FORTNIGHTLY: 26, MONTHLY: 12 }[input.payFrequency];
          grossPay = new Decimal(employee.annualSalary ?? "0").dividedBy(periodsPerYear).toFixed(4);
        } else {
          const manualHours = input.manualHoursByEmployeeId?.[employeeId];
          if (manualHours !== undefined) {
            hoursPaid = manualHours;
          } else if (employee.userId) {
            hoursPaid = await sumApprovedTimesheetHours(
              tx,
              actor.organizationId,
              employee.userId,
              input.periodStart,
              input.periodEnd,
            );
          } else {
            throw new InvalidPayRunError(
              `Employee "${employee.name}" is HOURLY with no linked user account to pull approved timesheet hours from — provide manualHoursByEmployeeId for this employee.`,
            );
          }
          grossPay = new Decimal(employee.hourlyRate ?? "0").times(hoursPaid).toFixed(4);
        }

        const ordinaryTimeEarnings = grossPay; // This slice's OTE simplification — see pay_run_lines' schema comment.

        const paygWithholding = calculatePaygWithholding({
          grossPayForPeriod: grossPay,
          payFrequency: input.payFrequency,
          taxFreeThresholdClaimed: employee.taxFreeThresholdClaimed,
          brackets: ruleSet.brackets,
          medicareLevy: {
            rate: ruleSet.medicareLevyRate,
            lowerThreshold: ruleSet.medicareLevyLowerThreshold,
            upperThreshold: ruleSet.medicareLevyUpperThreshold,
          },
        }).toString();

        const quarterToDateOteBefore = await sumQuarterToDateOteBefore(
          tx,
          actor.organizationId,
          employeeId,
          input.payDate,
        );
        const sg = calculateSuperGuarantee({
          ordinaryTimeEarningsForPeriod: ordinaryTimeEarnings,
          quarterToDateOteBefore,
          sgRate: ruleSet.sgRate,
          quarterlyContributionBaseCap: ruleSet.sgQuarterlyContributionBaseCap,
        });

        const netPay = Money.of(grossPay, currency).subtract(Money.of(paygWithholding, currency)).toString();

        const leave = calculateLeaveAccrual({
          employmentBasis: employee.employmentBasis,
          payFrequency: input.payFrequency,
          standardHoursPerWeek: employee.standardHoursPerWeek,
          hoursPaidThisPeriod: hoursPaid,
        });

        await tx.insert(payRunLines).values({
          organizationId: actor.organizationId,
          payRunId: created.id,
          employeeId,
          taxRuleSetId: ruleSet.id,
          hoursPaid,
          grossPay,
          ordinaryTimeEarnings,
          quarterToDateOte: sg.quarterToDateOteAfter.toString(),
          paygWithholding,
          superGuarantee: sg.superGuaranteeAmount.toString(),
          netPay,
          annualLeaveAccrued: leave.annualLeaveAccruedHours.toString(),
          personalLeaveAccrued: leave.personalLeaveAccruedHours.toString(),
        });
      }

      await AuditService.record(tx, actor, {
        action: "pay_run.created",
        entityType: "PayRun",
        entityId: created.id,
        after: {
          periodStart: input.periodStart.toISOString().slice(0, 10),
          periodEnd: input.periodEnd.toISOString().slice(0, 10),
          employeeCount: input.employeeIds.length,
          taxRuleSetLabel: ruleSet.label,
        },
      });

      return buildPayRunView(tx, actor.organizationId, created);
    });
  },

  /** Deletes a DRAFT pay run and its lines — never allowed once POSTED. */
  async discardDraft(actor: Actor, id: string): Promise<void> {
    assertPermission(actor, "payrun:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, id);
      if (run.status !== "DRAFT") throw new PayRunNotDraftError(id);
      await tx.delete(payRunLines).where(eq(payRunLines.payRunId, id));
      await tx.delete(payRuns).where(eq(payRuns.id, id));
      await AuditService.record(tx, actor, {
        action: "pay_run.discarded",
        entityType: "PayRun",
        entityId: id,
        before: { status: "DRAFT" },
      });
    });
  },

  /**
   * Posts the one combined payroll journal for this run and applies every
   * line's accrued leave to its employee's running balance — the two
   * effects this slice treats as happening together, atomically, at the
   * irreversible step (see this module's doc comment for why neither
   * happens at `create()` time).
   *
   * Journal (normal-signed):
   * - Debit `wagesExpenseAccountId` for the sum of `grossPay`
   * - Debit `superannuationExpenseAccountId` for the sum of `superGuarantee`
   * - Credit `paygWithholdingPayableAccountId` for the sum of `paygWithholding`
   * - Credit `superannuationPayableAccountId` for the sum of `superGuarantee`
   * - Credit `netWagesPayableAccountId` for the sum of `netPay`
   *
   * `netWagesPayableAccountId` is a LIABILITY, not a bank account — this
   * slice models pay as "posted" distinctly from "paid", the same
   * separation `PaymentRunService` already draws for supplier payments
   * (see that account's schema comment for why: no real bank-file payment
   * generation exists in this codebase). Settling it is a separate manual
   * payment against that payable.
   */
  async post(actor: Actor, id: string): Promise<PayRunView> {
    assertPermission(actor, "payrun:post");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadPayRunOr404(tx, actor.organizationId, id);
      if (run.status !== "DRAFT") throw new PayRunNotDraftError(id);

      const lines = await tx
        .select({ line: payRunLines, employee: employees })
        .from(payRunLines)
        .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
        .where(eq(payRunLines.payRunId, id));
      if (lines.length === 0) throw new InvalidPayRunError("This pay run has no lines to post.");

      const currency = "AUD";
      let totalGross = Money.zero(currency);
      let totalPayg = Money.zero(currency);
      let totalSuper = Money.zero(currency);
      let totalNet = Money.zero(currency);

      for (const { line } of lines) {
        totalGross = totalGross.add(Money.of(line.grossPay, currency));
        totalPayg = totalPayg.add(Money.of(line.paygWithholding, currency));
        totalSuper = totalSuper.add(Money.of(line.superGuarantee, currency));
        totalNet = totalNet.add(Money.of(line.netPay, currency));
      }

      const journalLines: JournalLineDraft[] = [];
      if (totalGross.isPositive()) journalLines.push({ accountId: run.wagesExpenseAccountId, debit: totalGross.toString(), currency });
      if (totalSuper.isPositive()) journalLines.push({ accountId: run.superannuationExpenseAccountId, debit: totalSuper.toString(), currency });
      if (totalPayg.isPositive()) journalLines.push({ accountId: run.paygWithholdingPayableAccountId, credit: totalPayg.toString(), currency });
      if (totalSuper.isPositive()) journalLines.push({ accountId: run.superannuationPayableAccountId, credit: totalSuper.toString(), currency });
      if (totalNet.isPositive()) journalLines.push({ accountId: run.netWagesPayableAccountId, credit: totalNet.toString(), currency });

      const posted = await PostingService.postJournal(actor, {
        postingDate: run.payDate,
        memo: `Payroll for ${run.periodStart.toISOString().slice(0, 10)} to ${run.periodEnd.toISOString().slice(0, 10)}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      for (const { line, employee } of lines) {
        await tx
          .update(employees)
          .set({
            annualLeaveBalanceHours: new Decimal(employee.annualLeaveBalanceHours)
              .plus(line.annualLeaveAccrued)
              .toFixed(4),
            personalLeaveBalanceHours: new Decimal(employee.personalLeaveBalanceHours)
              .plus(line.personalLeaveAccrued)
              .toFixed(4),
            updatedAt: new Date(),
          })
          .where(eq(employees.id, employee.id));
      }

      const [updated] = await tx
        .update(payRuns)
        .set({ status: "POSTED", journalEntryId: posted.entryId, postedAt: new Date(), postedById: actor.userId, updatedAt: new Date() })
        .where(eq(payRuns.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "pay_run.posted",
        entityType: "PayRun",
        entityId: id,
        before: { status: "DRAFT" },
        after: {
          status: "POSTED",
          journalEntryId: posted.entryId,
          totalGross: totalGross.toString(),
          totalPayg: totalPayg.toString(),
          totalSuper: totalSuper.toString(),
          totalNet: totalNet.toString(),
        },
      });

      return buildPayRunView(tx, actor.organizationId, updated!);
    });
  },
};

async function buildPayRunView(
  tx: TenantDb,
  organizationId: string,
  run: typeof payRuns.$inferSelect,
): Promise<PayRunView> {
  const rows = await tx
    .select({ line: payRunLines, employee: employees, ruleSet: payrollTaxRuleSets })
    .from(payRunLines)
    .innerJoin(employees, eq(employees.id, payRunLines.employeeId))
    .innerJoin(payrollTaxRuleSets, eq(payrollTaxRuleSets.id, payRunLines.taxRuleSetId))
    .where(and(eq(payRunLines.organizationId, organizationId), eq(payRunLines.payRunId, run.id)))
    .orderBy(asc(employees.name));

  const lines: PayRunLineView[] = rows.map((r) => ({
    id: r.line.id,
    employeeId: r.employee.id,
    employeeName: r.employee.name,
    employmentBasis: r.employee.employmentBasis,
    hoursPaid: r.line.hoursPaid,
    grossPay: r.line.grossPay,
    ordinaryTimeEarnings: r.line.ordinaryTimeEarnings,
    quarterToDateOte: r.line.quarterToDateOte,
    paygWithholding: r.line.paygWithholding,
    superGuarantee: r.line.superGuarantee,
    netPay: r.line.netPay,
    annualLeaveAccrued: r.line.annualLeaveAccrued,
    personalLeaveAccrued: r.line.personalLeaveAccrued,
    taxRuleSetLabel: r.ruleSet.label,
  }));

  const currency = "AUD";
  let totalGross = Money.zero(currency);
  let totalPayg = Money.zero(currency);
  let totalSuper = Money.zero(currency);
  let totalNet = Money.zero(currency);
  for (const l of lines) {
    totalGross = totalGross.add(Money.of(l.grossPay, currency));
    totalPayg = totalPayg.add(Money.of(l.paygWithholding, currency));
    totalSuper = totalSuper.add(Money.of(l.superGuarantee, currency));
    totalNet = totalNet.add(Money.of(l.netPay, currency));
  }

  return {
    id: run.id,
    payFrequency: run.payFrequency,
    periodStart: run.periodStart.toISOString().slice(0, 10),
    periodEnd: run.periodEnd.toISOString().slice(0, 10),
    payDate: run.payDate.toISOString().slice(0, 10),
    status: run.status,
    journalEntryId: run.journalEntryId,
    lines,
    totals: {
      grossPay: totalGross.toString(),
      paygWithholding: totalPayg.toString(),
      superGuarantee: totalSuper.toString(),
      netPay: totalNet.toString(),
    },
  };
}
