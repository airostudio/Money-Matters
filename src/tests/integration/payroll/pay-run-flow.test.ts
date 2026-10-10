import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";
import { createPayrollFixtures } from "../../helpers/payroll";
import { createProjectFixtures } from "../../helpers/projects";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { StpReportService } from "@/domain/payroll/stp-report-service";
import { TaxRuleService } from "@/domain/payroll/tax-rule-service";
import { ProjectService } from "@/domain/projects/project-service";
import { TimesheetService } from "@/domain/projects/timesheet-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { PayRunAccountWiring } from "@/domain/payroll/pay-run-service";

describe("Payroll — pay run flow (Phase 8 Slice 1)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let baseCurrency: string;
  let gl: PayRunAccountWiring;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("payroll-flow");
    owner = org.owner;
    baseCurrency = org.baseCurrency;
    gl = await createPayrollFixtures(owner, baseCurrency);
  });

  it("TaxRuleService resolves the correct rule set by pay date", async () => {
    const fy2526 = await TaxRuleService.resolve("AU", new Date("2025-08-15"));
    expect(fy2526.label).toBe("FY2025-26");
    const bracket1 = fy2526.brackets.find((b) => b.sequence === 1);
    expect(bracket1?.marginalRate).toBe("0.1600");

    const fy2627 = await TaxRuleService.resolve("AU", new Date("2026-10-05"));
    expect(fy2627.label).toBe("FY2026-27 (Payday Super)");
    expect(fy2627.version).toBe(2);
    const bracket1b = fy2627.brackets.find((b) => b.sequence === 1);
    expect(bracket1b?.marginalRate).toBe("0.1500");
  });

  it("registers a salaried employee and runs payroll, producing correct gross/PAYG/super/net and posting the GL correctly", async () => {
    const employee = await EmployeeService.create(owner, {
      name: "Alex Salary",
      employmentBasis: "SALARY",
      annualSalary: "104000.00", // 104,000 / 26 = 4,000.00/fortnight exactly
      payFrequency: "FORTNIGHTLY",
      taxFreeThresholdClaimed: true,
      startDate: new Date("2026-01-01"),
    });

    const payDate = new Date("2026-10-14");
    const run = await PayRunService.create(
      owner,
      {
        payFrequency: "FORTNIGHTLY",
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-14"),
        payDate,
        employeeIds: [employee.id],
      },
      gl,
    );

    expect(run.status).toBe("DRAFT");
    const line = run.lines[0]!;
    expect(line.grossPay).toBe("4000.0000");

    // Hand-computed FY2026-27 fortnightly withholding at $4,000/fortnight:
    // Annualized: 4000*26=104,000. Income tax: 4,020 + 30%*(104000-45000)=4,020+17,700=21,720.
    // Medicare: 104,000 >= 35,013 -> full 2% = 2,080. Annual withholding=23,800. /26=915.3846...
    expect(line.paygWithholding).toBe("915.3846");
    expect(line.netPay).toBe("3084.6154");

    // SG: 12% of 4000 = 480.00 (well under the $62,500 quarterly cap).
    expect(line.superGuarantee).toBe("480.0000");
    expect(line.taxRuleSetLabel).toBe("FY2026-27 (Payday Super)");
    expect(line.superCadence).toBe("PAYDAY");
    expect(line.superSafeByDate).toBe("2026-10-22"); // Wed 14 Oct + six weekdays

    // Leave: full-time (38h) fortnightly salary -> 152/26 and 76/26.
    expect(Number(line.annualLeaveAccrued)).toBeCloseTo(152 / 26, 3);
    expect(Number(line.personalLeaveAccrued)).toBeCloseTo(76 / 26, 3);

    const posted = await PayRunService.post(owner, run.id);
    expect(posted.status).toBe("POSTED");
    expect(posted.journalEntryId).toBeTruthy();

    // GL reconciliation: wages expense debit, super expense debit, and the
    // three payable credits all match the pay run's totals exactly.
    const trialBalance = await LedgerService.getTrialBalance(owner, payDate);
    const byId = new Map(trialBalance.map((r) => [r.accountId, r]));
    const wages = byId.get(gl.wagesExpenseAccountId)!;
    const superExp = byId.get(gl.superannuationExpenseAccountId)!;
    const paygPayable = byId.get(gl.paygWithholdingPayableAccountId)!;
    const superPayable = byId.get(gl.superannuationPayableAccountId)!;
    const netPayable = byId.get(gl.netWagesPayableAccountId)!;

    expect(wages.totalDebit).toBe("4000.0000");
    expect(superExp.totalDebit).toBe("480.0000");
    expect(paygPayable.totalCredit).toBe("915.3846");
    expect(superPayable.totalCredit).toBe("480.0000");
    expect(netPayable.totalCredit).toBe("3084.6154");

    // Leave balance applied to the employee only at POST time.
    const updatedEmployee = await EmployeeService.get(owner, employee.id);
    expect(Number(updatedEmployee.annualLeaveBalanceHours)).toBeCloseTo(152 / 26, 3);
    expect(Number(updatedEmployee.personalLeaveBalanceHours)).toBeCloseTo(76 / 26, 3);

    // STP-shaped report reflects the same figures and is clearly marked as not submitted.
    const stp = await StpReportService.forPayRun(owner, run.id);
    expect(stp.notSubmittedToAto).toBe(true);
    expect(stp.totals.grossPayments).toBe("4000.0000");
    expect(stp.totals.paygWithheld).toBe("915.3846");
    expect(stp.totals.superannuationLiability).toBe("480.0000");
  });

  it("pulls approved timesheet hours for an HOURLY employee and computes gross pay from them", async () => {
    const employeeUser = await createTestUser("Hourly Worker");
    const employee = await EmployeeService.create(owner, {
      name: "Jess Hourly",
      employmentBasis: "HOURLY",
      hourlyRate: "40.00",
      payFrequency: "WEEKLY",
      taxFreeThresholdClaimed: true,
      startDate: new Date("2026-01-01"),
      userId: employeeUser.id,
    });

    const projectFixtures = await createProjectFixtures(owner, baseCurrency);
    const project = await ProjectService.create(owner, {
      customerContactId: projectFixtures.customerContactId,
      code: `PAYROLL-${projectFixtures.projectCodeSuffix}`,
      name: "Payroll Test Project",
      currency: baseCurrency,
    });
    const entry = await TimesheetService.createManual(owner, {
      employeeUserId: employeeUser.id,
      projectId: project.id,
      entryDate: new Date("2026-10-06"),
      hours: "38.00",
      billable: false,
    });
    await TimesheetService.submit(owner, entry.id);
    await TimesheetService.approve(owner, entry.id);

    const run = await PayRunService.create(
      owner,
      {
        payFrequency: "WEEKLY",
        periodStart: new Date("2026-10-05"),
        periodEnd: new Date("2026-10-11"),
        payDate: new Date("2026-10-12"),
        employeeIds: [employee.id],
      },
      gl,
    );

    const line = run.lines[0]!;
    expect(line.hoursPaid).toBe("38.0000");
    expect(line.grossPay).toBe("1520.0000"); // 38 * 40
  });

  it("LEGACY quarterly path: tracks quarter-to-date OTE across pay runs and correctly applies/stops applying the SG cap", async () => {
    const employee = await EmployeeService.create(owner, {
      name: "Sam HighEarner",
      employmentBasis: "SALARY",
      annualSalary: "1600000.00", // 1,600,000 / 26 = 61,538.4615/fortnight — close to the $62,500 quarterly cap after one period.
      payFrequency: "FORTNIGHTLY",
      taxFreeThresholdClaimed: true,
      startDate: new Date("2026-01-01"),
    });

    const run1 = await PayRunService.create(
      owner,
      {
        payFrequency: "FORTNIGHTLY",
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-14"),
        payDate: new Date("2026-10-14"),
        employeeIds: [employee.id],
        legacyQuarterlySuper: true,
      },
      gl,
    );
    const line1 = run1.lines[0]!;
    expect(line1.taxRuleSetLabel).toBe("FY2026-27");
    expect(line1.superCadence).toBe("QUARTERLY");
    expect(line1.superSafeByDate).toBeNull();
    expect(line1.grossPay).toBe("61538.4615");
    // Full period OTE is under the $62,500 cap -> full 12% SG this period.
    expect(line1.superGuarantee).toBe("7384.6154"); // 61538.4615 * 0.12 rounds to this
    await PayRunService.post(owner, run1.id);

    const run2 = await PayRunService.create(
      owner,
      {
        payFrequency: "FORTNIGHTLY",
        periodStart: new Date("2026-10-15"),
        periodEnd: new Date("2026-10-28"),
        payDate: new Date("2026-10-28"),
        employeeIds: [employee.id],
        legacyQuarterlySuper: true,
      },
      gl,
    );
    const line2 = run2.lines[0]!;
    // Quarter-to-date OTE before run2 = 61,538.4615. Remaining room to the
    // $62,500 cap = 961.5385. This period's OTE (61,538.4615) far exceeds
    // that, so SG is capped at 961.5385 * 12% = 115.3846, NOT 12% of the
    // full period.
    expect(line2.superGuarantee).toBe("115.3846");
    expect(Number(line2.quarterToDateOte)).toBeCloseTo(61538.4615 * 2, 1);
  });


  it("PAYDAY (Payday Super) path: SG is on every payday against the ANNUAL base $270,830 (max SG $32,499.60), with a safe-by date per line", async () => {
    const employee = await EmployeeService.create(owner, {
      name: "Sam HighEarner",
      employmentBasis: "SALARY",
      annualSalary: "1600000.00", // 61,538.4615 per fortnight
      payFrequency: "FORTNIGHTLY",
      startDate: new Date("2026-01-01"),
    });
    const payDates = ["2026-10-14", "2026-10-28", "2026-11-11", "2026-11-25", "2026-12-09", "2026-12-23"];
    const lines = [];
    for (const [i, d] of payDates.entries()) {
      const start = new Date(new Date(d).getTime() - 13 * 86400000);
      const run = await PayRunService.create(
        owner,
        { payFrequency: "FORTNIGHTLY", periodStart: start, periodEnd: new Date(d), payDate: new Date(d), employeeIds: [employee.id] },
        gl,
      );
      await PayRunService.post(owner, run.id);
      lines.push(run.lines[0]!);
      expect(run.lines[0]!.superCadence, `run ${i + 1}`).toBe("PAYDAY");
    }
    // Run 2 would have been capped at 115.3846 under the legacy quarterly cap; under Payday Super it is the full 12%.
    expect(lines[0]!.superGuarantee).toBe("7384.6154");
    expect(lines[1]!.superGuarantee).toBe("7384.6154");
    expect(lines[3]!.superGuarantee).toBe("7384.6154"); // before run 4: 3 x 61,538.4615 = 184,615.3845 < 270,830
    // Before run 5: 4 x 61,538.4615 = 246,153.8460; room = 270,830 - 246,153.8460 = 24,676.1540; x 12% = 2,961.13848 -> 2,961.1385
    expect(lines[4]!.superGuarantee).toBe("2961.1385");
    // Before run 6 the annual base is exhausted: no more SG this financial year.
    expect(lines[5]!.superGuarantee).toBe("0.0000");
    const total = lines.reduce((s, l) => s + Number(l.superGuarantee), 0);
    // Each payday rounds to four decimal places, so the yearly total can differ from 12% x 270,830 by a sub-cent amount.
    expect(total).toBeLessThanOrEqual(32499.6 + 0.001);
    expect(total).toBeCloseTo(32499.6, 3);
    // Financial-year-to-date earnings are what the line records under PAYDAY.
    expect(Number(lines[5]!.quarterToDateOte)).toBeCloseTo(61538.4615 * 6, 2);
    // Safe-by: Wed 14 Oct -> Thu 22 Oct; Wed 28 Oct -> Thu 5 Nov.
    expect(lines[0]!.superSafeByDate).toBe("2026-10-22");
    expect(lines[1]!.superSafeByDate).toBe("2026-11-05");
  });

  it("a foreign resident is withheld at the foreign resident rates with no Medicare levy (approximation), and a resident is unaffected", async () => {
    const fr = await EmployeeService.create(owner, {
      name: "Fran Foreign",
      employmentBasis: "SALARY",
      annualSalary: "104000.00",
      payFrequency: "FORTNIGHTLY",
      startDate: new Date("2026-01-01"),
      taxResidency: "FOREIGN_RESIDENT",
    });
    const res = await EmployeeService.create(owner, {
      name: "Rae Resident",
      employmentBasis: "SALARY",
      annualSalary: "104000.00",
      payFrequency: "FORTNIGHTLY",
      startDate: new Date("2026-01-01"),
    });
    expect(fr.taxResidency).toBe("FOREIGN_RESIDENT");
    const run = await PayRunService.create(
      owner,
      { payFrequency: "FORTNIGHTLY", periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-14"), payDate: new Date("2026-10-14"), employeeIds: [fr.id, res.id] },
      gl,
    );
    const frLine = run.lines.find((l) => l.employeeId === fr.id)!;
    const resLine = run.lines.find((l) => l.employeeId === res.id)!;
    expect(frLine.paygWithholding).toBe("1200.0000"); // 104,000 x 30% = 31,200 / 26
    expect(frLine.netPay).toBe("2800.0000");
    expect(resLine.paygWithholding).toBe("915.3846");
  });

  it("rule set versions: the highest version wins by default, the seeded version-1 row is untouched and selectable as the legacy path", async () => {
    const v2 = await TaxRuleService.resolve("AU", new Date("2026-10-05"));
    expect(v2).toMatchObject({ version: 2, sgCadence: "PAYDAY", sgAnnualContributionBaseCap: "270830.0000", sgQuarterlyContributionBaseCap: null, sgRate: "0.1200" });
    expect(v2.requiresVerificationNote).toMatch(/Medicare levy low-income thresholds/);
    expect(v2.brackets.map((b) => b.marginalRate)).toEqual(["0.0000", "0.1500", "0.3000", "0.3700", "0.4500"]);
    expect(v2.foreignResidentBrackets.map((b) => [b.threshold, b.marginalRate])).toEqual([
      ["0.0000", "0.3000"],
      ["135000.0000", "0.3700"],
      ["190000.0000", "0.4500"],
    ]);
    const legacy = await TaxRuleService.resolve("AU", new Date("2026-10-05"), { legacyQuarterlySuper: true });
    expect(legacy).toMatchObject({ version: 1, label: "FY2026-27", sgCadence: "QUARTERLY", sgQuarterlyContributionBaseCap: "62500.0000", sgAnnualContributionBaseCap: null });
    expect(legacy.requiresVerificationNote).toMatch(/UNRESOLVED/); // the seeded v1 wording is preserved verbatim
    const fy2526 = await TaxRuleService.resolve("AU", new Date("2025-12-01"));
    expect(fy2526).toMatchObject({ version: 1, label: "FY2025-26", sgCadence: "QUARTERLY" });
    expect((await TaxRuleService.list("AU")).map((r) => `${r.label}#${r.version}`)).toEqual(["FY2025-26#1", "FY2026-27#1", "FY2026-27 (Payday Super)#2"]);
  });

  it("refuses to run a second pay run for the same employee over an overlapping period", async () => {
    const employee = await EmployeeService.create(owner, {
      name: "Dup Check",
      employmentBasis: "SALARY",
      annualSalary: "52000.00",
      payFrequency: "WEEKLY",
      startDate: new Date("2026-01-01"),
    });
    await PayRunService.create(
      owner,
      {
        payFrequency: "WEEKLY",
        periodStart: new Date("2026-10-05"),
        periodEnd: new Date("2026-10-11"),
        payDate: new Date("2026-10-12"),
        employeeIds: [employee.id],
      },
      gl,
    );

    await expect(
      PayRunService.create(
        owner,
        {
          payFrequency: "WEEKLY",
          periodStart: new Date("2026-10-05"),
          periodEnd: new Date("2026-10-11"),
          payDate: new Date("2026-10-12"),
          employeeIds: [employee.id],
        },
        gl,
      ),
    ).rejects.toThrow();
  });

  it("masks the TFN for a role with employee:read but not employee:manage", async () => {
    const employee = await EmployeeService.create(owner, {
      name: "TFN Holder",
      employmentBasis: "SALARY",
      annualSalary: "60000.00",
      payFrequency: "MONTHLY",
      startDate: new Date("2026-01-01"),
      tfn: "123456782",
      bankAccountNumber: "12345678",
    });
    expect(employee.tfn).toBe("123456782");
    expect(employee.tfnMasked).toBe("*****6782");

    const readOnlyActor: Actor = { ...owner, role: "ACCOUNTANT" };
    const viaAccountant = await EmployeeService.get(readOnlyActor, employee.id);
    expect(viaAccountant.tfn).toBeNull();
    expect(viaAccountant.tfnMasked).toBe("*****6782");
    expect(viaAccountant.bankAccountNumberMasked).toBe("****5678");
  });
});
