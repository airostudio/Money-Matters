import { AccountService } from "@/domain/accounts/account-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use chart of accounts + customer + tax code for sales tests.
 * Account/tax codes are suffixed with a counter so this can be called
 * more than once against the same organization (e.g. alongside
 * `createSampleAccounts`) without colliding on the org-unique code index.
 */
export async function createSalesFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const arAccount = await AccountService.create(actor, {
    code: `AR-${suffix}`,
    name: "Accounts Receivable",
    type: "ASSET",
    currency,
    isControlAccount: true,
  });
  const revenueAccount = await AccountService.create(actor, {
    code: `REV-${suffix}`,
    name: "Sales Revenue",
    type: "REVENUE",
    currency,
  });
  const otherRevenueAccount = await AccountService.create(actor, {
    code: `REV2-${suffix}`,
    name: "Consulting Revenue",
    type: "REVENUE",
    currency,
  });
  const taxPayableAccount = await AccountService.create(actor, {
    code: `TAXPAY-${suffix}`,
    name: "GST Payable",
    type: "LIABILITY",
    currency,
  });
  const bankAccount = await AccountService.create(actor, {
    code: `BANK-${suffix}`,
    name: "Business Bank Account",
    type: "ASSET",
    currency,
  });

  const taxCode = await TaxCodeService.create(actor, {
    code: `GST-${suffix}`,
    name: "GST 10%",
    rate: "0.1000",
    jurisdiction: "AU",
    effectiveFrom: new Date("2020-01-01"),
    payableAccountId: taxPayableAccount.id,
  });

  const customer = await ContactService.create(actor, {
    kind: "CUSTOMER",
    displayName: "Acme Pty Ltd",
    currency,
  });

  return {
    arAccountId: arAccount.id,
    revenueAccountId: revenueAccount.id,
    otherRevenueAccountId: otherRevenueAccount.id,
    taxPayableAccountId: taxPayableAccount.id,
    bankGlAccountId: bankAccount.id,
    taxCodeId: taxCode.id,
    customerContactId: customer.id,
  };
}
