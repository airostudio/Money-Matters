import { AccountService } from "@/domain/accounts/account-service";
import { FixedAssetClassService } from "@/domain/fixed-assets/asset-class-service";
import type { Actor } from "@/domain/permissions/permission-service";

let fixtureCounter = 0;

/**
 * A ready-to-use chart of accounts + asset class for fixed-assets tests —
 * the mirror of `src/tests/helpers/inventory.ts`. Account codes are
 * suffixed with a counter so this can be called more than once against the
 * same organization without colliding on the org-unique code index.
 */
export async function createFixedAssetFixtures(actor: Actor, currency: string) {
  fixtureCounter += 1;
  const suffix = String(fixtureCounter).padStart(2, "0");

  const assetAccount = await AccountService.create(actor, {
    code: `FA-${suffix}`,
    name: "Motor Vehicles — Cost",
    type: "ASSET",
    currency,
  });
  const accumulatedDepreciationAccount = await AccountService.create(actor, {
    code: `ACCDEP-${suffix}`,
    name: "Accumulated Depreciation — Motor Vehicles",
    type: "ASSET",
    currency,
  });
  const depreciationExpenseAccount = await AccountService.create(actor, {
    code: `DEPEXP-${suffix}`,
    name: "Depreciation Expense",
    type: "EXPENSE",
    currency,
  });
  const bankAccount = await AccountService.create(actor, {
    code: `BANKFA-${suffix}`,
    name: "Business Bank Account",
    type: "ASSET",
    currency,
  });
  const gainLossAccount = await AccountService.create(actor, {
    code: `GLDISP-${suffix}`,
    name: "Gain/Loss on Disposal of Fixed Assets",
    type: "REVENUE",
    currency,
  });
  const lossAccount = await AccountService.create(actor, {
    code: `LOSSWO-${suffix}`,
    name: "Loss on Write-off of Fixed Assets",
    type: "EXPENSE",
    currency,
  });
  const openingBalanceEquityAccount = await AccountService.create(actor, {
    code: `OBE-${suffix}`,
    name: "Opening Balance Equity",
    type: "EQUITY",
    currency,
  });

  const assetClass = await FixedAssetClassService.create(actor, {
    name: `Motor Vehicles ${suffix}`,
    defaultUsefulLifeMonths: 60,
  });

  return {
    assetClassId: assetClass.id,
    assetAccountId: assetAccount.id,
    accumulatedDepreciationAccountId: accumulatedDepreciationAccount.id,
    depreciationExpenseAccountId: depreciationExpenseAccount.id,
    bankAccountId: bankAccount.id,
    gainLossAccountId: gainLossAccount.id,
    lossAccountId: lossAccount.id,
    openingBalanceEquityAccountId: openingBalanceEquityAccount.id,
  };
}
