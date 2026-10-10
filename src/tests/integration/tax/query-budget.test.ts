import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createPayrollFixtures } from "../../helpers/payroll";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { BasService } from "@/domain/tax/bas-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { PayslipService } from "@/domain/payroll/payslip-service";
import { PayrollReportService } from "@/domain/payroll/payroll-report-service";
import { LeaveService } from "@/domain/payroll/leave-service";
import type { Actor } from "@/domain/permissions/permission-service";
import pg from "pg";

/**
 * Database budget (docs/architecture.md section 9a) for the BAS and payroll-operations services: ONE scoped
 * transaction at a time, and a statement count that does not grow with the number of documents. Counted at the
 * driver (every statement including BEGIN / set_config / COMMIT) against the real database.
 */
describe("BAS and payroll per-call database budget", () => {
  let owner: Actor;
  let employeeActor: Actor;
  let statements: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;
  let draftId: string;

  async function seed(count: number) {
    const org = await createTestOrg("bas-budget");
    owner = org.owner;
    const sales = await createSalesFixtures(owner, org.baseCurrency);
    const purchases = await createPurchasesFixtures(owner, org.baseCurrency);
    await TaxCodeService.setBasClassification(owner, sales.taxCodeId, { basTreatment: "TAXABLE", basCapital: false });
    await TaxCodeService.setBasClassification(owner, purchases.taxCodeId, { basTreatment: "TAXABLE", basCapital: false });
    for (let i = 0; i < count; i++) {
      const inv = await InvoiceService.create(owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date("2026-08-05"),
        dueDate: new Date("2026-08-20"),
        currency: org.baseCurrency,
        arAccountId: sales.arAccountId,
        lines: [{ description: "x", quantity: "1", unitPrice: "100", accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
      });
      await InvoiceService.approveAndPost(owner, inv.id);
      const bill = await BillService.create(owner, {
        supplierContactId: purchases.supplierContactId,
        issueDate: new Date("2026-08-06"),
        dueDate: new Date("2026-08-20"),
        currency: org.baseCurrency,
        apAccountId: purchases.apAccountId,
        lines: [{ description: "y", quantity: "1", unitPrice: "40", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId }],
      });
      await BillService.approveAndPost(owner, bill.id);
    }
    const gl = await createPayrollFixtures(owner, org.baseCurrency);
    employeeActor = await addTestMember(owner, "EMPLOYEE", "Emp");
    const emp = await EmployeeService.create(owner, {
      name: "Budget Employee",
      employmentBasis: "SALARY",
      annualSalary: "104000",
      payFrequency: "FORTNIGHTLY",
      startDate: new Date("2026-01-01"),
      userId: employeeActor.userId,
    });
    const run = await PayRunService.create(
      owner,
      { payFrequency: "FORTNIGHTLY", periodStart: new Date("2026-08-01"), periodEnd: new Date("2026-08-14"), payDate: new Date("2026-08-14"), employeeIds: [emp.id] },
      gl,
    );
    await PayRunService.post(owner, run.id);
    draftId = (await BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" })).id;
  }

  const measure = async (fn: () => Promise<unknown>) => {
    statements = [];
    tracker.reset();
    await fn();
    return { statements: statements.length, tenantCalls: tracker.tenantCalls.length, maxActive: tracker.maxActive };
  };

  beforeEach(async () => {
    await resetDatabase();
    spy?.mockRestore();
    const original = pg.Client.prototype.query;
    spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
  });

  afterAll(async () => {
    spy?.mockRestore();
    await closeTestPools();
  });

  it("each service call is one scoped transaction with a fixed statement count that does not grow with volume", async () => {
    await seed(1);
    const small = {
      bas: await measure(() => BasService.get(owner, draftId)),
      list: await measure(() => BasService.list(owner)),
      payslips: await measure(() => PayslipService.listMine(employeeActor)),
      summary: await measure(() => PayrollReportService.payrollSummary(owner, { from: new Date("2026-07-01"), to: new Date("2027-06-30") })),
      leave: await measure(() => LeaveService.list(owner, { scope: "all" })),
    };
    const slipId = (await PayslipService.listMine(employeeActor))[0]!.lineId;
    const slip = await measure(() => PayslipService.get(employeeActor, slipId));
    const finalised = await BasService.finalise(owner, draftId, { acknowledgeWarnings: true });
    const finalisedView = await measure(() => BasService.get(owner, finalised.id));

    // Grow the data: 12 more invoices and bills in the period.
    await resetDatabase();
    await seed(13);
    const large = {
      bas: await measure(() => BasService.get(owner, draftId)),
      list: await measure(() => BasService.list(owner)),
      payslips: await measure(() => PayslipService.listMine(employeeActor)),
      summary: await measure(() => PayrollReportService.payrollSummary(owner, { from: new Date("2026-07-01"), to: new Date("2027-06-30") })),
      leave: await measure(() => LeaveService.list(owner, { scope: "all" })),
    };

    for (const key of Object.keys(small) as Array<keyof typeof small>) {
      expect(small[key].tenantCalls).toBe(1);
      expect(small[key].maxActive).toBe(1);
      expect(large[key].statements).toBe(small[key].statements);
    }
    expect(slip.tenantCalls).toBe(1);
    expect(finalisedView.tenantCalls).toBe(1);
    expect(finalisedView.maxActive).toBe(1);
    // Absolute ceilings (BEGIN + set_config + COMMIT included).
    expect(small.bas.statements).toBeLessThanOrEqual(18);
    expect(finalisedView.statements).toBeLessThanOrEqual(34);
    expect(small.list.statements).toBeLessThanOrEqual(4);
    expect(small.payslips.statements).toBeLessThanOrEqual(4);
    expect(slip.statements).toBeLessThanOrEqual(6);
    console.log("BUDGET", JSON.stringify({ basDraftView: small.bas.statements, basFinalisedView: finalisedView.statements, basList: small.list.statements, payslipList: small.payslips.statements, payslip: slip.statements, payrollSummary: small.summary.statements, leaveList: small.leave.statements }));
  });
});
