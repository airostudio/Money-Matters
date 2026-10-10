import { withTenant } from "@/db/tenant";
import { paymentRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AccountService } from "@/domain/accounts/account-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { addTestMember } from "./db";
import { createPayrollFixtures } from "./payroll";
import { createPurchasesFixtures } from "./purchases";
import { createSalesFixtures } from "./sales";

export const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * A realistic, hand-computable mix for the Phase 9 Slice 2 integration tests
 * ("today" is 2026-10-05, a Monday):
 *
 *  - Bank: 8,000 opening + 2,000 received from Acme's two settled invoices = 10,000.
 *  - Acme (slow payer): settled A (due 06-15, paid 06-25 = 10 late) and B (due 07-15, paid 07-29 = 14 late)
 *    → average 12 days late over 2 settled invoices. Open: C 3,000 due 10-09 (a Friday), D 2,000 due 09-25 (overdue).
 *  - Fresh Co (no history): open E 1,500 due 10-20, F 700 due 09-30 (overdue). A recurring 1,200/month invoice from 10-10.
 *  - Supplier: open bills BILL-1 4,000 due 10-12, BILL-2 500 due 09-28 (overdue), BILL-3 6,000 due 10-31 in a payment run
 *    for 10-15. A recurring 900/month bill from 10-01.
 *  - Payroll: one POSTED fortnightly pay run, pay date 10-02 (net 3,084.6154, PAYG 915.3846, super 480.0000 all unpaid).
 */
export async function seedForecastData(
  owner: Actor,
  currency: string,
  opts: { paymentRunStatus?: "APPROVED" | "AWAITING_APPROVAL" } = {},
) {
  const sales = await createSalesFixtures(owner, currency);
  const purchases = await createPurchasesFixtures(owner, currency);
  const payroll = await createPayrollFixtures(owner, currency);
  const equity = await AccountService.create(owner, { code: "EQ-TEST", name: "Owner Equity (test)", type: "EQUITY", currency });

  await BankAccountService.create(owner, { name: "Operating", glAccountId: sales.bankGlAccountId, currency });
  await PostingService.postJournal(owner, {
    postingDate: D("2026-05-01"),
    lines: [
      { accountId: sales.bankGlAccountId, debit: "8000.00", currency },
      { accountId: equity.id, credit: "8000.00", currency },
    ],
  });

  const acme = sales.customerContactId;
  const fresh = (await ContactService.create(owner, { kind: "CUSTOMER", displayName: "Fresh Co", currency })).id;

  async function invoice(customerContactId: string, issue: string, due: string, amount: string) {
    const created = await InvoiceService.create(owner, {
      customerContactId,
      issueDate: D(issue),
      dueDate: D(due),
      currency,
      arAccountId: sales.arAccountId,
      lines: [{ description: "Work", quantity: "1", unitPrice: amount, accountId: sales.revenueAccountId }],
    });
    return InvoiceService.approveAndPost(owner, created.id);
  }
  async function pay(customerContactId: string, invoiceId: string, date: string, amount: string) {
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId,
      paymentDate: D(date),
      amount,
      currency,
      method: "BANK_TRANSFER",
      depositAccountId: sales.bankGlAccountId,
      allocations: [{ invoiceId, amount }],
    });
  }

  const invA = await invoice(acme, "2026-06-01", "2026-06-15", "1000.00");
  await pay(acme, invA.id, "2026-06-25", "1000.00");
  const invB = await invoice(acme, "2026-07-01", "2026-07-15", "1000.00");
  await pay(acme, invB.id, "2026-07-29", "1000.00");
  const invC = await invoice(acme, "2026-09-09", "2026-10-09", "3000.00");
  const invD = await invoice(acme, "2026-08-26", "2026-09-25", "2000.00");
  const invE = await invoice(fresh, "2026-09-20", "2026-10-20", "1500.00");
  const invF = await invoice(fresh, "2026-08-31", "2026-09-30", "700.00");

  async function bill(issue: string, due: string, amount: string) {
    const created = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: D(issue),
      dueDate: D(due),
      currency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Materials", quantity: "1", unitPrice: amount, accountId: purchases.expenseAccountId }],
    });
    return BillService.approveAndPost(owner, created.id);
  }
  const bill1 = await bill("2026-09-12", "2026-10-12", "4000.00");
  const bill2 = await bill("2026-08-28", "2026-09-28", "500.00");
  const bill3 = await bill("2026-09-30", "2026-10-31", "6000.00");

  // BILL-3 goes into a payment run for 10-15. `approve` approves AND pays in one step in this codebase,
  // so the run is left AWAITING_APPROVAL; when the test wants the (never-persisted-by-the-services)
  // APPROVED-but-unpaid state, it is forced directly — see CashForecastService's note on that branch.
  const accountant = await addTestMember(owner, "ACCOUNTANT", "Approver");
  const run = await PaymentRunService.create(owner, {
    paymentDate: D("2026-10-15"),
    currency,
    paymentAccountId: sales.bankGlAccountId,
    billIds: [bill3.id],
  });
  await PaymentRunService.submitForApproval(owner, run!.id);
  if ((opts.paymentRunStatus ?? "APPROVED") === "APPROVED") {
    await withTenant(owner.organizationId, (tx) => tx.update(paymentRuns).set({ status: "APPROVED" }).where(eq(paymentRuns.id, run!.id)));
  }

  const recurringInvoice = await RecurringInvoiceService.create(owner, {
    customerContactId: fresh,
    name: "Monthly retainer",
    currency,
    arAccountId: sales.arAccountId,
    frequency: "MONTHLY",
    startDate: D("2026-10-10"),
    lines: [{ description: "Retainer", quantity: "1", unitPrice: "1200.00", accountId: sales.revenueAccountId }],
  });
  const recurringBill = await RecurringBillService.create(owner, {
    supplierContactId: purchases.supplierContactId,
    name: "Office rent",
    currency,
    apAccountId: purchases.apAccountId,
    frequency: "MONTHLY",
    startDate: D("2026-10-01"),
    lines: [{ description: "Rent", quantity: "1", unitPrice: "900.00", accountId: purchases.expenseAccountId }],
  });

  const employee = await EmployeeService.create(owner, {
    name: "Alex Salary",
    employmentBasis: "SALARY",
    annualSalary: "104000.00",
    payFrequency: "FORTNIGHTLY",
    taxFreeThresholdClaimed: true,
    startDate: D("2026-01-01"),
  });
  const payRun = await PayRunService.create(
    owner,
    {
      payFrequency: "FORTNIGHTLY",
      periodStart: D("2026-09-19"),
      periodEnd: D("2026-10-02"),
      payDate: D("2026-10-02"),
      employeeIds: [employee.id],
    },
    payroll,
  );
  await PayRunService.post(owner, payRun.id);

  return {
    sales,
    purchases,
    payroll,
    bankGlAccountId: sales.bankGlAccountId,
    revenueAccountId: sales.revenueAccountId,
    expenseAccountId: purchases.expenseAccountId,
    acme,
    fresh,
    invoices: { A: invA.id, B: invB.id, C: invC.id, D: invD.id, E: invE.id, F: invF.id },
    bills: { one: bill1.id, two: bill2.id, three: bill3.id },
    paymentRunId: run!.id,
    recurringInvoiceId: recurringInvoice.id,
    recurringBillId: recurringBill.id,
    accountant,
  };
}

export type ForecastSeed = Awaited<ReturnType<typeof seedForecastData>>;
