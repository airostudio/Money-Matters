import { AccountService } from "@/domain/accounts/account-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { PayRunAccountWiring } from "@/domain/payroll/pay-run-service";

let fixtureCounter = 0;

/** A ready-to-use set of payroll GL accounts for tests — mirrors `src/tests/helpers/fixed-assets.ts`. */
export async function createPayrollFixtures(actor: Actor, currency: string): Promise<PayRunAccountWiring> {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const wagesExpenseAccountId = (
    await AccountService.create(actor, { code: `WAGES-${suffix}`, name: "Wages Expense", type: "EXPENSE", currency })
  ).id;
  const superannuationExpenseAccountId = (
    await AccountService.create(actor, { code: `SUPEXP-${suffix}`, name: "Superannuation Expense", type: "EXPENSE", currency })
  ).id;
  const paygWithholdingPayableAccountId = (
    await AccountService.create(actor, { code: `PAYG-${suffix}`, name: "PAYG Withholding Payable", type: "LIABILITY", currency })
  ).id;
  const superannuationPayableAccountId = (
    await AccountService.create(actor, { code: `SUPPAY-${suffix}`, name: "Superannuation Payable", type: "LIABILITY", currency })
  ).id;
  const netWagesPayableAccountId = (
    await AccountService.create(actor, { code: `NETWAGES-${suffix}`, name: "Net Wages Payable", type: "LIABILITY", currency })
  ).id;

  return {
    wagesExpenseAccountId,
    superannuationExpenseAccountId,
    paygWithholdingPayableAccountId,
    superannuationPayableAccountId,
    netWagesPayableAccountId,
  };
}
