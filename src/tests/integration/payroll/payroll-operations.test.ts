import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { createPayrollFixtures } from "../../helpers/payroll";
import { auditLogs, leaveRequests, payrollPayments } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AccountService } from "@/domain/accounts/account-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService, type PayRunAccountWiring } from "@/domain/payroll/pay-run-service";
import { PayslipService } from "@/domain/payroll/payslip-service";
import { PayrollPaymentService } from "@/domain/payroll/payroll-payment-service";
import { PayrollReportService } from "@/domain/payroll/payroll-report-service";
import { LeaveService } from "@/domain/payroll/leave-service";
import { BasService } from "@/domain/tax/bas-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

/**
 * Phase 8 Slice 3: payroll operations. Hand-worked figures (FY2026-27 rule set, fortnightly):
 *   Alex: 104,000 p.a. -> gross 4,000.0000 ; PAYG (4,020 + 30% x 59,000 + 2% Medicare 2,080)/26 = 915.3846 ; net 3,084.6154 ; SG 480.0000
 *   Bo:    52,000 p.a. -> gross 2,000.0000 ; PAYG (4,020 + 30% x 7,000 = 6,120 ; + 1,040 Medicare = 7,160)/26 = 275.3846 ; net 1,724.6154 ; SG 240.0000
 *   Run totals: gross 6,000 ; PAYG 1,190.7692 ; super 720 ; net 4,809.2308
 */
describe("Payroll operations (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let gl: PayRunAccountWiring;
  let bankId: string;
  let alexActor: Actor;
  let boActor: Actor;
  let alexId: string;
  let boId: string;

  async function newRun(start: string, end: string, employeeIds: string[]) {
    return PayRunService.create(
      owner,
      {
        payFrequency: "FORTNIGHTLY",
        periodStart: new Date(start),
        periodEnd: new Date(end),
        payDate: new Date(end),
        employeeIds,
      },
      gl,
    );
  }

  async function balanceOf(accountId: string, asOf = new Date("2027-01-01")) {
    const tb = await LedgerService.getTrialBalance(owner, asOf);
    const row = tb.find((r) => r.accountId === accountId);
    return row ? { debit: row.totalDebit, credit: row.totalCredit } : { debit: "0.0000", credit: "0.0000" };
  }

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("payroll-ops");
    owner = org.owner;
    currency = org.baseCurrency;
    gl = await createPayrollFixtures(owner, currency);
    bankId = (await AccountService.create(owner, { code: "BANK-P", name: "Payroll Bank", type: "ASSET", currency })).id;
    alexActor = await addTestMember(owner, "EMPLOYEE", "Alex");
    boActor = await addTestMember(owner, "EMPLOYEE", "Bo");
    alexId = (
      await EmployeeService.create(owner, {
        name: "Alex Salary",
        employmentBasis: "SALARY",
        annualSalary: "104000.00",
        payFrequency: "FORTNIGHTLY",
        startDate: new Date("2026-01-01"),
        userId: alexActor.userId,
        bankAccountName: "Alex Salary",
        bankBsb: "032-001",
        bankAccountNumber: "123456789",
        superFundName: "Test Super Fund",
      })
    ).id;
    boId = (
      await EmployeeService.create(owner, {
        name: "Bo Salary",
        employmentBasis: "SALARY",
        annualSalary: "52000.00",
        payFrequency: "FORTNIGHTLY",
        startDate: new Date("2026-01-01"),
        userId: boActor.userId,
        bankBsb: "083-004",
        bankAccountNumber: "55667788",
      })
    ).id;
  });

  describe("payslips", () => {
    it("shows gross/PAYG/super/net, leave balances and year-to-date, and only to the employee (or a payroll manager)", async () => {
      const run1 = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await PayRunService.post(owner, run1.id);
      const run2 = await newRun("2026-10-15", "2026-10-28", [alexId]);
      await PayRunService.post(owner, run2.id);

      const mine = await PayslipService.listMine(alexActor);
      expect(mine.map((s) => s.payDate)).toEqual(["2026-10-28", "2026-10-14"]);
      const first = await PayslipService.get(alexActor, mine[1]!.lineId);
      expect(first).toMatchObject({
        employeeName: "Alex Salary",
        grossPay: "4000.0000",
        paygWithholding: "915.3846",
        netPay: "3084.6154",
        superGuarantee: "480.0000",
        superFundName: "Test Super Fund",
        paidToAccount: "*****6789",
      });
      expect(first.ytd).toMatchObject({ financialYearStart: "2026-07-01", grossPay: "4000.0000", paygWithholding: "915.3846", netPay: "3084.6154", superGuarantee: "480.0000" });
      expect(Number(first.leave.annualBalanceAfter)).toBeCloseTo(152 / 26, 3);
      const second = await PayslipService.get(alexActor, mine[0]!.lineId);
      expect(second.ytd.grossPay).toBe("8000.0000");
      expect(second.ytd.netPay).toBe("6169.2308");
      expect(Number(second.leave.annualBalanceAfter)).toBeCloseTo((152 / 26) * 2, 3);

      // Bo cannot read Alex's payslip: it is "not found", not "forbidden".
      await expect(PayslipService.get(boActor, mine[0]!.lineId)).rejects.toThrow(/not found/);
      // A bookkeeper (no employee:manage) is not the employee either.
      await expect(PayslipService.get(actorWithRole(owner, "BOOKKEEPER"), mine[0]!.lineId)).rejects.toThrow(/not found/);
      // A payroll manager (employee:manage) can.
      expect((await PayslipService.get(actorWithRole(owner, "PAYROLL_MANAGER"), mine[0]!.lineId)).employeeName).toBe("Alex Salary");
      expect((await PayslipService.listForEmployee(owner, alexId)).length).toBe(2);
      await expect(PayslipService.listForEmployee(alexActor, boId)).rejects.toBeInstanceOf(PermissionDeniedError);
      // Not available to non-human actors.
      await expect(PayslipService.get({ ...owner, type: "AI" }, mine[0]!.lineId)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PayslipService.listMine({ ...alexActor, type: "API" })).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("a DRAFT run has no payslip", async () => {
      const draft = await newRun("2026-10-01", "2026-10-14", [alexId]);
      await expect(PayslipService.get(owner, draft.lines[0]!.id)).rejects.toThrow(/not found/);
      expect(await PayslipService.listMine(alexActor)).toEqual([]);
    });
  });

  describe("settlement, remittances and the ledger", () => {
    it("pays net wages through the ledger, refuses a double payment, and a reversal re-opens the liability", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await expect(PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") })).rejects.toThrow(/POSTED/);
      await PayRunService.post(owner, run.id);

      expect((await PayrollPaymentService.netWagesPosition(owner, run.id)).outstanding).toBe("4809.2308");
      // The paying account must be a real ASSET account.
      await expect(
        PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: gl.wagesExpenseAccountId, paymentDate: new Date("2026-10-15") }),
      ).rejects.toThrow(/ASSET/);
      // Non-human and read-only payroll roles are refused.
      await expect(
        PayrollPaymentService.payNetWages({ ...owner, type: "AI" }, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") }),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        PayrollPaymentService.payNetWages(actorWithRole(owner, "BOOKKEEPER"), run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") }),
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      const payment = await PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15"), reference: "PAYRUN-1" });
      expect(payment.amount).toBe("4809.2308");
      const netPayable = await balanceOf(gl.netWagesPayableAccountId);
      expect(netPayable).toEqual({ debit: "4809.2308", credit: "4809.2308" }); // owed and settled
      expect((await balanceOf(bankId)).credit).toBe("4809.2308");
      expect((await PayrollPaymentService.netWagesPosition(owner, run.id)).outstanding).toBe("0.0000");
      await expect(PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") })).rejects.toThrow(/already paid/);

      await PayrollPaymentService.reverse(owner, payment.id, "Paid the wrong account");
      expect((await PayrollPaymentService.netWagesPosition(owner, run.id)).outstanding).toBe("4809.2308");
      await expect(PayrollPaymentService.reverse(owner, payment.id, "Paid the wrong account")).rejects.toThrow(/already been reversed/);
    });

    it("records super and PAYG remittances against the liability, never above what is outstanding", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await PayRunService.post(owner, run.id);

      await expect(
        PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.paygWithholdingPayableAccountId, bankAccountId: bankId, amount: "10", paymentDate: new Date("2026-10-20") }),
      ).rejects.toThrow(/not the Superannuation Payable/);
      await expect(
        PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "720.01", paymentDate: new Date("2026-10-20") }),
      ).rejects.toThrow(/exceeds what is outstanding/);
      await PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "700", paymentDate: new Date("2026-10-20"), reference: "SUPER-Q4" });
      await expect(
        PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "30", paymentDate: new Date("2026-10-21") }),
      ).rejects.toThrow(/exceeds/);
      await PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "20", paymentDate: new Date("2026-10-21") });
      expect((await PayrollPaymentService.remittancePosition(owner, "SUPER", gl.superannuationPayableAccountId)).outstanding).toBe("0.0000");
      expect(await balanceOf(gl.superannuationPayableAccountId)).toEqual({ debit: "720.0000", credit: "720.0000" });

      await PayrollPaymentService.recordPaygRemittance(owner, { liabilityAccountId: gl.paygWithholdingPayableAccountId, bankAccountId: bankId, amount: "1000", paymentDate: new Date("2026-10-22") });
      expect((await PayrollPaymentService.remittancePosition(owner, "PAYG", gl.paygWithholdingPayableAccountId)).outstanding).toBe("190.7692");
      await expect(PayrollPaymentService.recordPaygRemittance(owner, { liabilityAccountId: gl.paygWithholdingPayableAccountId, bankAccountId: bankId, amount: "0", paymentDate: new Date("2026-10-22") })).rejects.toThrow(/greater than zero/);
    });

    it("the payments table is append-only for the application role: amounts cannot be edited and rows cannot be deleted", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId]);
      await PayRunService.post(owner, run.id);
      const payment = await PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") });
      const edit = await pgMessage(withTenant(owner.organizationId, (tx) => tx.update(payrollPayments).set({ amount: "1.0000" }).where(eq(payrollPayments.id, payment.id))));
      expect(edit).toMatch(/permission denied/);
      const del = await pgMessage(withTenant(owner.organizationId, (tx) => tx.delete(payrollPayments).where(eq(payrollPayments.id, payment.id))));
      expect(del).toMatch(/permission denied/);
    });
  });

  describe("pay run reversal", () => {
    it("reverses the journal, marks the run REVERSED, unwinds leave, and lets a corrected run cover the same period", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await PayRunService.post(owner, run.id);
      expect(Number((await EmployeeService.get(owner, alexId)).annualLeaveBalanceHours)).toBeCloseTo(152 / 26, 3);

      // Refused while net wages are recorded as paid.
      const payment = await PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") });
      await expect(PayRunService.reverse(owner, run.id, "Wrong hours entered")).rejects.toThrow(/Reverse that payment first/);
      await PayrollPaymentService.reverse(owner, payment.id, "Reversing the payment first");

      await expect(PayRunService.reverse(owner, run.id, "short")).rejects.toThrow(/10 characters/);
      await expect(PayRunService.reverse(actorWithRole(owner, "BOOKKEEPER"), run.id, "Wrong hours entered")).rejects.toBeInstanceOf(PermissionDeniedError);
      const reversed = await PayRunService.reverse(owner, run.id, "Wrong hours entered");
      expect(reversed.status).toBe("REVERSED");

      // The ledger nets to zero on every payroll account.
      for (const id of [gl.wagesExpenseAccountId, gl.superannuationExpenseAccountId]) {
        const b = await balanceOf(id);
        expect(b.debit).toBe(b.credit);
      }
      for (const id of [gl.paygWithholdingPayableAccountId, gl.superannuationPayableAccountId, gl.netWagesPayableAccountId]) {
        const b = await balanceOf(id);
        expect(b.debit).toBe(b.credit);
      }
      expect(Number((await EmployeeService.get(owner, alexId)).annualLeaveBalanceHours)).toBeCloseTo(0, 4);
      // A reversed run is not postable again, has no payslip, and cannot be reversed twice.
      await expect(PayRunService.post(owner, run.id)).rejects.toThrow();
      await expect(PayRunService.reverse(owner, run.id, "Reversing again")).rejects.toThrow(/REVERSED/);
      expect(await PayslipService.listMine(alexActor)).toEqual([]);

      // The same period can now be run again (the duplicate-period check ignores REVERSED runs) and super QTD restarts.
      const again = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      expect(again.lines.find((l) => l.employeeId === alexId)!.quarterToDateOte).toBe("4000.0000");
      await PayRunService.post(owner, again.id);
    });

    it("refuses a reversal that would leave more super remitted than is owed", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId]);
      await PayRunService.post(owner, run.id);
      await PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "480", paymentDate: new Date("2026-10-20") });
      await expect(PayRunService.reverse(owner, run.id, "Wrong employee included")).rejects.toThrow(/Reverse the remittance first/);
    });

    it("BAS: a reversed run is W1/W2 +gross in the pay period and -gross in the period the reversal is dated", async () => {
      const run = await newRun("2026-07-30", "2026-08-12", [alexId]);
      await PayRunService.post(owner, run.id);
      await PayRunService.reverse(owner, run.id, "Posted in error for BAS test");
      const q3 = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
      expect(q3.figures.labels.W1).toBe("4000.0000");
      expect(q3.figures.labels.W2).toBe("915.3846");
      const today = new Date();
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const now = await BasService.preview(owner, { periodStart: start, periodEnd: end, frequency: "MONTHLY" });
      expect(now.figures.labels.W1).toBe("-4000.0000");
      expect(now.figures.labels.W2).toBe("-915.3846");
    });
  });

  describe("leave workflow", () => {
    async function firstRunPosted() {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await PayRunService.post(owner, run.id);
    }

    it("request -> approve -> deducted at the next pay run -> restored if that run is reversed", async () => {
      await firstRunPosted(); // Alex now has ~5.8462 h annual leave
      const req = await LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-20"), endDate: new Date("2026-10-20"), hours: "5", reason: "Appointment" });
      expect(req.status).toBe("PENDING");

      // An employee cannot approve (no permission); a manager cannot approve their own request.
      await expect(LeaveService.approve(alexActor, req.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      const approved = await LeaveService.approve(owner, req.id, "Enjoy");
      expect(approved).toMatchObject({ status: "APPROVED", decidedById: owner.userId });

      // Balance check counts approved-but-undeducted leave: 5.8462 - 5 = 0.8462 available.
      const second = await LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-22"), endDate: new Date("2026-10-22"), hours: "1" });
      await expect(LeaveService.approve(owner, second.id)).rejects.toThrow(/balance is 0\.8462/);
      await LeaveService.reject(owner, second.id, "Not enough leave");

      const run2 = await newRun("2026-10-15", "2026-10-28", [alexId]);
      expect(run2.lines[0]!.annualLeaveTaken).toBe("5.0000");
      expect(run2.lines[0]!.personalLeaveTaken).toBe("0.0000");
      await PayRunService.post(owner, run2.id);
      const alex = await EmployeeService.get(owner, alexId);
      expect(Number(alex.annualLeaveBalanceHours)).toBeCloseTo((152 / 26) * 2 - 5, 3);
      const slip = await PayslipService.get(alexActor, (await PayslipService.listMine(alexActor))[0]!.lineId);
      expect(slip.leave.annualTaken).toBe("5.0000");
      expect(Number(slip.leave.annualBalanceAfter)).toBeCloseTo((152 / 26) * 2 - 5, 3);
      expect((await LeaveService.list(alexActor, { scope: "mine" })).find((r) => r.id === req.id)!.appliedPayRunId).toBe(run2.id);
      // Already deducted: cannot be cancelled.
      await expect(LeaveService.cancel(alexActor, req.id)).rejects.toThrow(/already been deducted/);

      await PayRunService.reverse(owner, run2.id, "Run included the wrong leave");
      expect(Number((await EmployeeService.get(owner, alexId)).annualLeaveBalanceHours)).toBeCloseTo(152 / 26, 3);
      const released = (await LeaveService.list(owner, { scope: "all" })).find((r) => r.id === req.id)!;
      expect(released.status).toBe("APPROVED");
      expect(released.appliedPayRunId).toBeNull();
      // The next corrected run picks it up again.
      const run3 = await newRun("2026-10-15", "2026-10-28", [alexId]);
      expect(run3.lines[0]!.annualLeaveTaken).toBe("5.0000");
    });

    it("a draft goes stale (and refuses to post) if approvals change after it was created", async () => {
      await firstRunPosted();
      const run2 = await newRun("2026-10-15", "2026-10-28", [alexId]);
      const req = await LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-20"), endDate: new Date("2026-10-20"), hours: "2" });
      await LeaveService.approve(owner, req.id);
      await expect(PayRunService.post(owner, run2.id)).rejects.toThrow(/changed after this draft was created/);
    });

    it("segregation: nobody decides their own request; read-only roles cannot request; non-humans are refused", async () => {
      const manager = await addTestMember(owner, "MANAGER", "Mgr");
      await EmployeeService.create(owner, {
        name: "Mgr Employee",
        employmentBasis: "SALARY",
        annualSalary: "78000",
        payFrequency: "FORTNIGHTLY",
        startDate: new Date("2026-01-01"),
        userId: manager.userId,
      });
      const mReq = await LeaveService.request(manager, { leaveType: "PERSONAL", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-05"), hours: "7.6" });
      await expect(LeaveService.approve(manager, mReq.id)).rejects.toThrow(/own leave request/);
      await expect(LeaveService.reject(manager, mReq.id)).rejects.toThrow(/own leave request/);

      const readOnly = await addTestMember(owner, "READ_ONLY");
      await expect(LeaveService.request(readOnly, { leaveType: "ANNUAL", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-05"), hours: "1" })).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(LeaveService.request({ ...alexActor, type: "AI" }, { leaveType: "ANNUAL", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-05"), hours: "1" })).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(LeaveService.approve({ ...owner, type: "API" }, mReq.id)).rejects.toBeInstanceOf(PermissionDeniedError);
      // A login with no employee record cannot request.
      const bookkeeper = await addTestMember(owner, "BOOKKEEPER");
      await expect(LeaveService.request(bookkeeper, { leaveType: "ANNUAL", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-05"), hours: "1" })).rejects.toThrow(/not linked/);
      // Only the requester sees "mine"; everyone's needs leave:read.
      await expect(LeaveService.list(alexActor, { scope: "all" })).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await LeaveService.list(boActor, { scope: "mine" })).length).toBe(0);
      // Validation
      await expect(LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-06"), endDate: new Date("2026-10-05"), hours: "1" })).rejects.toThrow(/end date/);
      await expect(LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-05"), endDate: new Date("2026-10-05"), hours: "0" })).rejects.toThrow(/greater than zero/);
    });
  });

  describe("reports", () => {
    it("summarise posted runs to hand-worked totals", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await PayRunService.post(owner, run.id);
      await PayrollPaymentService.recordPaygRemittance(owner, { liabilityAccountId: gl.paygWithholdingPayableAccountId, bankAccountId: bankId, amount: "1000", paymentDate: new Date("2026-10-22") });
      await PayrollPaymentService.recordSuperRemittance(owner, { liabilityAccountId: gl.superannuationPayableAccountId, bankAccountId: bankId, amount: "300", paymentDate: new Date("2026-10-22") });

      const range = { from: new Date("2026-07-01"), to: new Date("2027-06-30") };
      const summary = await PayrollReportService.payrollSummary(owner, range);
      expect(summary.totals).toEqual({ grossPay: "6000.0000", paygWithholding: "1190.7692", superGuarantee: "720.0000", netPay: "4809.2308" });
      expect(summary.lines.map((l) => [l.employeeName, l.grossPay])).toEqual([["Alex Salary", "4000.0000"], ["Bo Salary", "2000.0000"]]);

      const payg = await PayrollReportService.paygSummary(owner, range);
      expect(payg.months).toEqual([{ month: "2026-10", withheld: "1190.7692", remitted: "1000.0000" }]);
      expect(payg.outstandingNow[0]!.outstanding).toBe("190.7692");

      const sup = await PayrollReportService.superLiabilityByQuarter(owner);
      expect(sup.quarters).toEqual([{ quarterStart: "2026-10-01", accrued: "720.0000" }]);
      expect(sup.remittedByQuarter).toEqual([{ quarterStart: "2026-10-01", remitted: "300.0000" }]);
      expect(sup.outstandingNow[0]!.outstanding).toBe("420.0000");

      const liab = await PayrollReportService.leaveLiability(owner);
      // Alex: 104000/(52*38) = 52.6316 ; hours 152/26 = 5.8462 -> 5.8462 x 52.6316 = 307.6948 (4dp rounding of each factor)
      const alex = liab.rows.find((r) => r.employeeName === "Alex Salary")!;
      expect(alex.baseHourlyRate).toBe("52.6316");
      expect(Number(alex.annualLeaveEstimate)).toBeCloseTo(5.8462 * 52.631578947, 2);
      // Permission parity: a role without payrun:read is refused.
      await expect(PayrollReportService.payrollSummary(actorWithRole(owner, "MANAGER"), range)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PayrollReportService.leaveLiability(actorWithRole(owner, "ACCOUNTS_PAYABLE"))).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("ABA file", () => {
    const input = {
      header: { financialInstitution: "tst", userName: "Test Pty Ltd", userId: "123456", description: "PAYROLL" },
      trace: { bsb: "062-000", accountNumber: "10203040", remitterName: "Test Pty Ltd" },
      processingDate: new Date("2026-10-15"),
    };

    it("generates the Direct Entry file from posted pay, fails closed on missing bank details, and audits no bank numbers", async () => {
      const run = await newRun("2026-10-01", "2026-10-14", [alexId, boId]);
      await expect(PayrollPaymentService.generateAba(owner, run.id, input)).rejects.toThrow(/POSTED/);
      await PayRunService.post(owner, run.id);
      const aba = await PayrollPaymentService.generateAba(owner, run.id, input);
      const lines = aba.content.split("\r\n");
      expect(lines).toHaveLength(5); // header, 2 details, trailer, trailing empty
      expect(lines[0]!.startsWith("0")).toBe(true);
      expect(lines[1]!.slice(1, 8)).toBe("032-001");
      expect(lines[1]!.slice(20, 30)).toBe("0000308462"); // Alex 3084.6154 -> 308,462 cents
      expect(lines[2]!.slice(1, 8)).toBe("083-004");
      expect(lines[2]!.slice(20, 30)).toBe("0000172462"); // Bo 1724.6154 -> 172,462 cents
      expect(lines[3]!.slice(20, 30)).toBe("0000480924");
      expect(lines[3]!.slice(74, 80)).toBe("000002");
      expect(aba.totalCents).toBe("480924");
      expect(aba.roundingDifference).toBe("-0.0092"); // exact 4809.2308 minus the 4809.24 written (each employee rounded to a cent)
      expect(aba.filename).toBe("payroll-2026-10-14.aba");

      // Only counts and totals reach the audit log, never a BSB or account number.
      const audit = await withTenant(owner.organizationId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.action, "payroll_payment.aba_generated")));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toMatch(/123456789|55667788|032-001|10203040/);

      // Permission: needs both payroll_payment:manage and employee:manage.
      await expect(PayrollPaymentService.generateAba(actorWithRole(owner, "ACCOUNTANT"), run.id, input)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(PayrollPaymentService.generateAba({ ...owner, type: "AI" }, run.id, input)).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await PayrollPaymentService.generateAba(actorWithRole(owner, "PAYROLL_MANAGER"), run.id, input)).recordCount).toBe(2);
    });

    it("refuses when an employee has no bank details", async () => {
      const carol = await EmployeeService.create(owner, {
        name: "Carol NoBank",
        employmentBasis: "SALARY",
        annualSalary: "52000",
        payFrequency: "FORTNIGHTLY",
        startDate: new Date("2026-01-01"),
      });
      const run = await newRun("2026-10-01", "2026-10-14", [carol.id]);
      await PayRunService.post(owner, run.id);
      await expect(PayrollPaymentService.generateAba(owner, run.id, input)).rejects.toThrow(/No bank details on file for: Carol NoBank/);
    });
  });

  it("tenant isolation: leave requests and payroll payments are invisible to another organisation", async () => {
    const run = await newRun("2026-10-01", "2026-10-14", [alexId]);
    await PayRunService.post(owner, run.id);
    await PayrollPaymentService.payNetWages(owner, run.id, { bankAccountId: bankId, paymentDate: new Date("2026-10-15") });
    await LeaveService.request(alexActor, { leaveType: "ANNUAL", startDate: new Date("2026-10-20"), endDate: new Date("2026-10-20"), hours: "1" });
    const other = await createTestOrg("payroll-ops-other");
    const payments = await withTenant(other.organizationId, (tx) => tx.select().from(payrollPayments));
    const leave = await withTenant(other.organizationId, (tx) => tx.select().from(leaveRequests));
    expect(payments).toHaveLength(0);
    expect(leave).toHaveLength(0);
    await expect(PayrollPaymentService.listForRun(other.owner, run.id)).resolves.toEqual([]);
  });
});
