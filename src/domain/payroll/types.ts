import type { employeeStatusEnum, employmentBasisEnum, payFrequencyEnum, payRunStatusEnum } from "@/db/schema";

export type EmploymentBasis = (typeof employmentBasisEnum.enumValues)[number];
export type PayFrequencyDb = (typeof payFrequencyEnum.enumValues)[number];
export type EmployeeStatus = (typeof employeeStatusEnum.enumValues)[number];
export type PayRunStatus = (typeof payRunStatusEnum.enumValues)[number];

export interface CreateEmployeeInput {
  name: string;
  employmentBasis: EmploymentBasis;
  /** Required for SALARY, ignored for HOURLY. Decimal string. */
  annualSalary?: string;
  /** Required for HOURLY, ignored for SALARY. Decimal string. */
  hourlyRate?: string;
  /** Decimal string, defaults to "38.00". */
  standardHoursPerWeek?: string;
  payFrequency: PayFrequencyDb;
  taxFreeThresholdClaimed?: boolean;
  startDate: Date;
  userId?: string;
  tfn?: string;
  superFundName?: string;
  superFundAbn?: string;
  superMemberAccountNumber?: string;
  bankAccountName?: string;
  bankBsb?: string;
  bankAccountNumber?: string;
}

export type UpdateEmployeeInput = Omit<CreateEmployeeInput, "startDate"> & { startDate?: Date };

export interface EmployeeView {
  id: string;
  name: string;
  employmentBasis: EmploymentBasis;
  annualSalary: string | null;
  hourlyRate: string | null;
  standardHoursPerWeek: string;
  payFrequency: PayFrequencyDb;
  taxFreeThresholdClaimed: boolean;
  startDate: string;
  terminationDate: string | null;
  status: EmployeeStatus;
  userId: string | null;
  /** Full value — only ever populated when the caller holds `employee:manage`; see `EmployeeService.get`. */
  tfn: string | null;
  /** Masked, last-4 form — always populated when a tfn exists, regardless of permission. */
  tfnMasked: string | null;
  superFundName: string | null;
  superFundAbn: string | null;
  superMemberAccountNumber: string | null;
  bankAccountName: string | null;
  bankBsb: string | null;
  bankAccountNumberMasked: string | null;
  annualLeaveBalanceHours: string;
  personalLeaveBalanceHours: string;
}

export interface CreatePayRunInput {
  payFrequency: PayFrequencyDb;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  employeeIds: string[];
  /** Decimal string hours, keyed by employeeId — required for an HOURLY employee with no linked `userId` (no timesheets to pull from); optional override for one that does have timesheets (explicit always wins over the timesheet sum). */
  manualHoursByEmployeeId?: Record<string, string>;
}

export interface PayRunLineView {
  id: string;
  employeeId: string;
  employeeName: string;
  employmentBasis: EmploymentBasis;
  hoursPaid: string;
  grossPay: string;
  ordinaryTimeEarnings: string;
  quarterToDateOte: string;
  paygWithholding: string;
  superGuarantee: string;
  netPay: string;
  annualLeaveAccrued: string;
  personalLeaveAccrued: string;
  taxRuleSetLabel: string;
}

export interface PayRunView {
  id: string;
  payFrequency: PayFrequencyDb;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: PayRunStatus;
  journalEntryId: string | null;
  lines: PayRunLineView[];
  totals: {
    grossPay: string;
    paygWithholding: string;
    superGuarantee: string;
    netPay: string;
  };
}

export interface StpReportLine {
  employeeId: string;
  employeeName: string;
  incomeType: "SALARY_AND_WAGES";
  grossPayments: string;
  paygWithheld: string;
  superannuationLiability: string;
}

export interface StpShapedReport {
  payRunId: string;
  payDate: string;
  lines: StpReportLine[];
  totals: {
    grossPayments: string;
    paygWithheld: string;
    superannuationLiability: string;
  };
  /** Always true in this slice — see `StpReportService`'s doc comment: this report shows the data an STP Phase 2 submission WOULD contain; it is never actually transmitted to the ATO. */
  notSubmittedToAto: true;
}
