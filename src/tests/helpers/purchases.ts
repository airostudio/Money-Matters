import { AccountService } from "@/domain/accounts/account-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use chart of accounts + supplier + tax code for purchases
 * tests — the mirror of `src/tests/helpers/sales.ts`. Account/tax codes are
 * suffixed with a counter so this can be called more than once against the
 * same organization without colliding on the org-unique code index.
 */
export async function createPurchasesFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const apAccount = await AccountService.create(actor, {
    code: `AP-${suffix}`,
    name: "Accounts Payable",
    type: "LIABILITY",
    currency,
    isControlAccount: true,
  });
  const expenseAccount = await AccountService.create(actor, {
    code: `EXP-${suffix}`,
    name: "Office Supplies",
    type: "EXPENSE",
    currency,
  });
  const otherExpenseAccount = await AccountService.create(actor, {
    code: `EXP2-${suffix}`,
    name: "Contractor Costs",
    type: "EXPENSE",
    currency,
  });
  const taxReceivableAccount = await AccountService.create(actor, {
    code: `TAXREC-${suffix}`,
    name: "GST Receivable",
    type: "ASSET",
    currency,
  });
  const bankAccount = await AccountService.create(actor, {
    code: `BANKAP-${suffix}`,
    name: "Business Bank Account",
    type: "ASSET",
    currency,
  });

  const taxCode = await TaxCodeService.create(actor, {
    code: `GSTIN-${suffix}`,
    name: "GST 10% (purchases)",
    rate: "0.1000",
    jurisdiction: "AU",
    effectiveFrom: new Date("2020-01-01"),
    receivableAccountId: taxReceivableAccount.id,
  });

  const supplier = await ContactService.create(actor, {
    kind: "SUPPLIER",
    displayName: "Bunnings Trade Pty Ltd",
    currency,
  });

  return {
    apAccountId: apAccount.id,
    expenseAccountId: expenseAccount.id,
    otherExpenseAccountId: otherExpenseAccount.id,
    taxReceivableAccountId: taxReceivableAccount.id,
    bankGlAccountId: bankAccount.id,
    taxCodeId: taxCode.id,
    supplierContactId: supplier.id,
  };
}
