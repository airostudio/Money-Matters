import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createFixedAssetFixtures } from "../../helpers/fixed-assets";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { FixedAssetClassService } from "@/domain/fixed-assets/asset-class-service";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { DepreciationService } from "@/domain/fixed-assets/depreciation-service";
import { FixedAssetRegisterService } from "@/domain/fixed-assets/fixed-asset-register-service";
import { FixedAssetNotActiveError, InvalidAcquisitionSourceError } from "@/domain/fixed-assets/errors";
import { BillService } from "@/domain/purchases/bill-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Fixed Assets — full flow (Phase 7 Slice 3)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let baseCurrency: string;
  let fa: Awaited<ReturnType<typeof createFixedAssetFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("fixed-assets-flow");
    owner = org.owner;
    baseCurrency = org.baseCurrency;
    fa = await createFixedAssetFixtures(owner, baseCurrency);
    purchases = await createPurchasesFixtures(owner, baseCurrency);
  });

  /** Posts the acquisition journal a standalone registration relies on already existing, then registers the asset — mirroring an opening-balance import. */
  async function registerStandaloneAsset(cost: string, acquisitionDate = new Date("2026-01-01")) {
    await PostingService.postJournal(owner, {
      postingDate: acquisitionDate,
      lines: [
        { accountId: fa.assetAccountId, debit: cost, currency: baseCurrency },
        { accountId: fa.openingBalanceEquityAccountId, credit: cost, currency: baseCurrency },
      ],
    });
    return FixedAssetService.registerAsset(owner, {
      assetClassId: fa.assetClassId,
      name: "Delivery Van",
      acquisitionDate,
      acquisitionCost: cost,
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      usefulLifeMonths: 60,
    });
  }

  it("registers a standalone asset without posting anything itself", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    expect(asset.status).toBe("ACTIVE");
    expect(asset.accumulatedDepreciation).toBe("0.0000");

    // The only posting that happened was the manual journal this test
    // posted itself before calling registerAsset — the balance is exactly
    // that journal's amount, not double-counted by a second posting.
    const trialBalance = await LedgerService.getTrialBalance(owner);
    const assetRow = trialBalance.find((r) => r.accountId === fa.assetAccountId);
    expect(assetRow!.balance).toBe("12000.0000");
  });

  it("registers an asset from an already-posted bill line coded to the fixed-asset account, with no second posting", async () => {
    const bill = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-02-01"),
      dueDate: new Date("2026-03-03"),
      currency: baseCurrency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Forklift", quantity: "1", unitPrice: "8000.00", accountId: fa.assetAccountId }],
    });
    const posted = await BillService.approveAndPost(owner, bill.id);
    const billWithLines = await BillService.get(owner, posted.id);
    const line = billWithLines!.lines[0]!;

    const asset = await FixedAssetService.registerFromBillLine(owner, {
      billLineId: line.id,
      assetClassId: fa.assetClassId,
      name: "Forklift",
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      usefulLifeMonths: 36,
    });

    expect(asset.acquisitionCost).toBe("8000.0000");
    expect(asset.acquisitionDate.toISOString().slice(0, 10)).toBe("2026-02-01");
    expect(asset.sourceBillLineId).toBe(line.id);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const assetRow = trialBalance.find((r) => r.accountId === fa.assetAccountId);
    // Only the bill's own posting touched this account — registering the
    // asset added no second entry.
    expect(assetRow!.balance).toBe("8000.0000");
  });

  it("refuses to register an asset from a DRAFT bill line", async () => {
    const bill = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-02-01"),
      dueDate: new Date("2026-03-03"),
      currency: baseCurrency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Forklift", quantity: "1", unitPrice: "8000.00", accountId: fa.assetAccountId }],
    });
    const billWithLines = await BillService.get(owner, bill.id);
    const line = billWithLines!.lines[0]!;

    await expect(
      FixedAssetService.registerFromBillLine(owner, {
        billLineId: line.id,
        assetClassId: fa.assetClassId,
        name: "Forklift",
        assetAccountId: fa.assetAccountId,
        accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
        depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      }),
    ).rejects.toThrow(InvalidAcquisitionSourceError);
  });

  it("runs straight-line depreciation for a period and posts a journal debiting expense, crediting accumulated depreciation", async () => {
    const asset = await registerStandaloneAsset("12000.00");

    const result = await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") });
    expect(result.journalEntryId).toBeTruthy();
    expect(result.totalPosted).toBe("200.0000"); // 12000/60

    const entry = await LedgerService.getJournalEntry(owner, result.journalEntryId!);
    const expenseLine = entry!.lines.find((l) => l.accountId === fa.depreciationExpenseAccountId);
    const accDepLine = entry!.lines.find((l) => l.accountId === fa.accumulatedDepreciationAccountId);
    expect(expenseLine!.debit).toBe("200.0000");
    expect(accDepLine!.credit).toBe("200.0000");

    const refreshed = await FixedAssetService.get(owner, asset.id);
    expect(refreshed!.accumulatedDepreciation).toBe("200.0000");
  });

  it("running the same period twice does not double-post — idempotent per asset per period", async () => {
    await registerStandaloneAsset("12000.00");

    const first = await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") });
    expect(first.journalEntryId).toBeTruthy();

    const second = await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-20") });
    // Same calendar month as the first run -> nothing left to do.
    expect(second.journalEntryId).toBeNull();
    expect(second.lines).toHaveLength(0);

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const accDepRow = trialBalance.find((r) => r.accountId === fa.accumulatedDepreciationAccountId);
    // Exactly one month's worth of depreciation, not two.
    expect(accDepRow!.balance).toBe("-200.0000");
  });

  it("running a second (different) period accumulates correctly on top of the first", async () => {
    const asset = await registerStandaloneAsset("12000.00");

    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") });
    const second = await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-02-15") });

    expect(second.totalPosted).toBe("200.0000");
    const refreshed = await FixedAssetService.get(owner, asset.id);
    expect(refreshed!.accumulatedDepreciation).toBe("400.0000"); // two months

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const accDepRow = trialBalance.find((r) => r.accountId === fa.accumulatedDepreciationAccountId);
    expect(accDepRow!.balance).toBe("-400.0000");
  });

  it("disposing an asset for more than net book value posts a gain", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") }); // accDep 200, NBV 11800

    const disposal = await FixedAssetService.disposeAsset(owner, asset.id, {
      disposalDate: new Date("2026-02-01"),
      proceeds: "12500.00",
      proceedsAccountId: fa.bankAccountId,
      gainLossAccountId: fa.gainLossAccountId,
    });

    expect(disposal.status).toBe("DISPOSED");
    expect(disposal.disposalGainLoss).toBe("700.0000"); // 12500 - 11800

    const entry = await LedgerService.getJournalEntry(owner, disposal.journalEntryId!);
    const gainLine = entry!.lines.find((l) => l.accountId === fa.gainLossAccountId);
    expect(gainLine!.credit).toBe("700.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    expect(trialBalance.find((r) => r.accountId === fa.assetAccountId)!.balance).toBe("0.0000");
    expect(trialBalance.find((r) => r.accountId === fa.accumulatedDepreciationAccountId)!.balance).toBe("0.0000");
  });

  it("disposing an asset for less than net book value posts a loss", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") }); // accDep 200, NBV 11800

    const disposal = await FixedAssetService.disposeAsset(owner, asset.id, {
      disposalDate: new Date("2026-02-01"),
      proceeds: "10000.00",
      proceedsAccountId: fa.bankAccountId,
      gainLossAccountId: fa.gainLossAccountId,
    });

    expect(disposal.disposalGainLoss).toBe("-1800.0000"); // 10000 - 11800

    const entry = await LedgerService.getJournalEntry(owner, disposal.journalEntryId!);
    const lossLine = entry!.lines.find((l) => l.accountId === fa.gainLossAccountId);
    expect(lossLine!.debit).toBe("1800.0000");
  });

  it("writing off an asset recognizes the full remaining net book value as a loss", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") }); // accDep 200, NBV 11800

    const writeOff = await FixedAssetService.writeOffAsset(owner, asset.id, {
      disposalDate: new Date("2026-02-01"),
      lossAccountId: fa.lossAccountId,
    });

    expect(writeOff.status).toBe("WRITTEN_OFF");
    expect(writeOff.disposalGainLoss).toBe("-11800.0000");

    const entry = await LedgerService.getJournalEntry(owner, writeOff.journalEntryId!);
    const lossLine = entry!.lines.find((l) => l.accountId === fa.lossAccountId);
    expect(lossLine!.debit).toBe("11800.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    expect(trialBalance.find((r) => r.accountId === fa.assetAccountId)!.balance).toBe("0.0000");
  });

  it("refuses to depreciate, dispose, or write off an asset that is already disposed", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    await FixedAssetService.disposeAsset(owner, asset.id, {
      disposalDate: new Date("2026-01-10"),
      proceeds: "12000.00",
      proceedsAccountId: fa.bankAccountId,
      gainLossAccountId: fa.gainLossAccountId,
    });

    await expect(
      FixedAssetService.disposeAsset(owner, asset.id, {
        disposalDate: new Date("2026-01-20"),
        proceeds: "1.00",
        proceedsAccountId: fa.bankAccountId,
        gainLossAccountId: fa.gainLossAccountId,
      }),
    ).rejects.toThrow(FixedAssetNotActiveError);

    await expect(
      FixedAssetService.writeOffAsset(owner, asset.id, {
        disposalDate: new Date("2026-01-20"),
        lossAccountId: fa.lossAccountId,
      }),
    ).rejects.toThrow(FixedAssetNotActiveError);

    // A disposed asset is ACTIVE-only for depreciation purposes too — the
    // run simply skips it (status filter), rather than erroring, so this
    // just confirms no further depreciation posts for it.
    const result = await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-02-15") });
    expect(result.lines.some((l) => l.assetId === asset.id)).toBe(false);
  });

  it("the Fixed Asset Register reconciles its total net book value to the GL exactly", async () => {
    const assetA = await registerStandaloneAsset("12000.00", new Date("2026-01-01"));
    const assetB = await FixedAssetService.registerAsset(owner, {
      assetClassId: fa.assetClassId,
      name: "Office Fit-out",
      acquisitionDate: new Date("2026-01-16"),
      acquisitionCost: "6200.00",
      residualValue: "200.00",
      usefulLifeMonths: 60,
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
    });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-16"),
      lines: [
        { accountId: fa.assetAccountId, debit: "6200.00", currency: baseCurrency },
        { accountId: fa.openingBalanceEquityAccountId, credit: "6200.00", currency: baseCurrency },
      ],
    });

    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") });
    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-02-15") });

    const report = await FixedAssetRegisterService.getRegister(owner);
    expect(report.assets).toHaveLength(2);
    expect(report.fullyReconciled).toBe(true);

    const reconciliation = report.reconciliation.find((r) => r.assetAccountId === fa.assetAccountId)!;
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.difference).toBe("0.0000");

    const rowA = report.assets.find((r) => r.assetId === assetA.id)!;
    expect(rowA.netBookValue).toBe("11600.0000"); // 12000 - 400 (2 full months)
    const rowB = report.assets.find((r) => r.assetId === assetB.id)!;
    // Jan prorated (16 days of 31) + full Feb at (6200-200)/60 = 100/mo.
    expect(Number(rowB.accumulatedDepreciation)).toBeGreaterThan(0);
  });

  it("a disposed asset drops out of the register, and the GL stays reconciled afterward", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    await DepreciationService.runForPeriod(owner, { periodMonth: new Date("2026-01-15") });
    await FixedAssetService.disposeAsset(owner, asset.id, {
      disposalDate: new Date("2026-02-01"),
      proceeds: "11800.00",
      proceedsAccountId: fa.bankAccountId,
      gainLossAccountId: fa.gainLossAccountId,
    });

    const report = await FixedAssetRegisterService.getRegister(owner);
    expect(report.assets).toHaveLength(0);
    expect(report.totalNetBookValue).toBe("0.0000");
    expect(report.fullyReconciled).toBe(true);
  });

  it("the depreciation schedule projects to the end of useful life at residual value", async () => {
    const asset = await registerStandaloneAsset("12000.00");
    const schedule = await FixedAssetRegisterService.getDepreciationSchedule(owner, asset.id);
    expect(schedule).toHaveLength(60);
    expect(schedule.at(-1)!.netBookValueAfter).toBe("0.0000");
  });

  it("asset classes provide defaults that registration can override", async () => {
    const assetClass = await FixedAssetClassService.create(owner, {
      name: "Computer Equipment",
      defaultUsefulLifeMonths: 36,
    });
    expect(assetClass.defaultDepreciationMethod).toBe("STRAIGHT_LINE");
    expect(assetClass.defaultUsefulLifeMonths).toBe(36);

    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-01"),
      lines: [
        { accountId: fa.assetAccountId, debit: "3000.00", currency: baseCurrency },
        { accountId: fa.openingBalanceEquityAccountId, credit: "3000.00", currency: baseCurrency },
      ],
    });
    const asset = await FixedAssetService.registerAsset(owner, {
      assetClassId: assetClass.id,
      name: "Laptop",
      acquisitionDate: new Date("2026-01-01"),
      acquisitionCost: "3000.00",
      assetAccountId: fa.assetAccountId,
      accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
      // usefulLifeMonths omitted -> defaults from the class (36).
    });
    expect(asset.usefulLifeMonths).toBe(36);
  });
});
