import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use chart of accounts + tax code for expense-claim tests —
 * the mirror of `src/tests/helpers/purchases.ts`. Account/tax codes are
 * suffixed with a counter so this can be called more than once against the
 * same organization without colliding on the org-unique code index.
 */
export async function createExpenseFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const payableAccount = await AccountService.create(actor, {
    code: `EXPAY-${suffix}`,
    name: "Employee Reimbursements Payable",
    type: "LIABILITY",
    currency,
    isControlAccount: true,
  });
  const expenseAccount = await AccountService.create(actor, {
    code: `EXPACC-${suffix}`,
    name: "Travel Expenses",
    type: "EXPENSE",
    currency,
  });
  const otherExpenseAccount = await AccountService.create(actor, {
    code: `EXPACC2-${suffix}`,
    name: "Meals & Entertainment",
    type: "EXPENSE",
    currency,
  });
  const taxReceivableAccount = await AccountService.create(actor, {
    code: `EXPTAX-${suffix}`,
    name: "GST Receivable",
    type: "ASSET",
    currency,
  });
  const bankAccount = await AccountService.create(actor, {
    code: `EXPBANK-${suffix}`,
    name: "Business Bank Account",
    type: "ASSET",
    currency,
  });

  const taxCode = await TaxCodeService.create(actor, {
    code: `EXPGST-${suffix}`,
    name: "GST 10% (expenses)",
    rate: "0.1000",
    jurisdiction: "AU",
    effectiveFrom: new Date("2020-01-01"),
    receivableAccountId: taxReceivableAccount.id,
  });

  return {
    payableAccountId: payableAccount.id,
    expenseAccountId: expenseAccount.id,
    otherExpenseAccountId: otherExpenseAccount.id,
    taxReceivableAccountId: taxReceivableAccount.id,
    bankGlAccountId: bankAccount.id,
    taxCodeId: taxCode.id,
  };
}
