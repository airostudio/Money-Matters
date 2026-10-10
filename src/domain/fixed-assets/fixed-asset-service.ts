import { and, asc, eq, notInArray, or } from "drizzle-orm";
import { accounts, billLines, bills, contacts, fixedAssets, organizations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  FixedAssetNotActiveError,
  FixedAssetNotFoundError,
  InvalidAcquisitionSourceError,
  InvalidDisposalError,
  InvalidFixedAssetError,
} from "./errors";
import { loadAssetClassOr404 } from "./asset-class-service";
import { calculateDisposalGainLoss, calculateWriteOffLoss } from "./disposal-calculations";
import type {
  DisposeAssetInput,
  RegisterFixedAssetFromBillLineInput,
  RegisterFixedAssetInput,
  WriteOffAssetInput,
} from "./types";

async function loadAccountOrThrow(
  tx: TenantDb,
  organizationId: string,
  accountId: string,
  expectedType: "ASSET" | "EXPENSE" | undefined,
  label: string,
) {
  const [account] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new InvalidFixedAssetError(`${label} account ${accountId} does not exist in this organization.`);
  if (!account.isActive) throw new InvalidFixedAssetError(`${label} account "${account.name}" is inactive.`);
  if (expectedType && account.type !== expectedType) {
    throw new InvalidFixedAssetError(
      `${label} account "${account.name}" must be an ${expectedType} account (it is ${account.type}).`,
    );
  }
  return account;
}

export async function loadFixedAssetOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, id), eq(fixedAssets.organizationId, organizationId)));
  if (!row) throw new FixedAssetNotFoundError(id);
  return row;
}

function assertActive(asset: { name: string; status: string }) {
  if (asset.status !== "ACTIVE") {
    throw new FixedAssetNotActiveError(asset.name, asset.status);
  }
}

async function baseCurrencyOf(tx: TenantDb, organizationId: string): Promise<string> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
  return org?.baseCurrency ?? "AUD";
}

interface ResolvedAccounts {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

async function validateAccountWiring(
  tx: TenantDb,
  organizationId: string,
  input: ResolvedAccounts,
) {
  await loadAccountOrThrow(tx, organizationId, input.assetAccountId, "ASSET", "Asset");
  await loadAccountOrThrow(
    tx,
    organizationId,
    input.accumulatedDepreciationAccountId,
    "ASSET",
    "Accumulated depreciation",
  );
  await loadAccountOrThrow(
    tx,
    organizationId,
    input.depreciationExpenseAccountId,
    "EXPENSE",
    "Depreciation expense",
  );
}

/**
 * Registers and tracks capitalized fixed assets (master spec §28). A
 * `FixedAsset` row is a subsidiary-ledger record — **registering one never
 * posts a journal for the acquisition itself**. The designated
 * `assetAccountId`'s GL balance must already reflect the acquisition cost,
 * from whichever of these already happened:
 *
 * - A bill line was coded directly to the asset account (the normal path —
 *   `registerFromBillLine` reads the already-posted bill line's own
 *   `accountId`/`lineAmount`/the bill's `issueDate` and just links them;
 *   `BillService`'s existing debit already landed on the right account, so
 *   there is no second parallel posting to keep in sync — exactly the
 *   reasoning Phase 7 Slice 2 used for a PURCHASE movement needing no extra
 *   journal lines, see `docs/accounting-engine.md` §10).
 * - A manual journal, or an opening-balance import, posted the debit some
 *   other way (`registerAsset`, the standalone path — required to exist
 *   for exactly this reason, since not every asset arrives via a bill).
 *
 * `FixedAssetRegisterService` is the correctness check: it sums the
 * register's net book value and compares it against the GL balance of
 * `assetAccountId`/`accumulatedDepreciationAccountId`, the same spirit as
 * `InventoryValuationService` — if the two ever disagree, a bill was coded
 * to the wrong account or an asset was registered against the wrong one,
 * and the reconciliation report says so rather than hiding it.
 */
export const FixedAssetService = {
  async list(actor: Actor, opts: { status?: string } = {}) {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(fixedAssets.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(fixedAssets.status, opts.status as "ACTIVE"));
      return tx
        .select()
        .from(fixedAssets)
        .where(and(...conditions))
        .orderBy(asc(fixedAssets.name));
    });
  },

  async get(actor: Actor, id: string) {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(fixedAssets)
        .where(and(eq(fixedAssets.id, id), eq(fixedAssets.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },

  /**
   * Candidate bill lines for `registerFromBillLine`: posted (not DRAFT/VOID)
   * bill lines coded to an ASSET-type account, that haven't already
   * registered a fixed asset — the "new-asset" UI's picker for the normal
   * acquisition path. Deliberately does not filter by any specific account
   * (any ASSET account could be a capitalized line the user coded
   * correctly), leaving the actual account-match check to
   * `registerFromBillLine` itself.
   */
  async listUnregisteredAssetBillLines(actor: Actor) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const alreadyRegistered = await tx
        .select({ billLineId: fixedAssets.sourceBillLineId })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.organizationId, actor.organizationId), eq(fixedAssets.status, "ACTIVE")));
      const excludeIds = alreadyRegistered.map((r) => r.billLineId).filter((id): id is string => !!id);

      const rows = await tx
        .select({ line: billLines, bill: bills, account: accounts, supplier: contacts })
        .from(billLines)
        .innerJoin(bills, eq(bills.id, billLines.billId))
        .innerJoin(accounts, eq(accounts.id, billLines.accountId))
        .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
        .where(
          and(
            eq(billLines.organizationId, actor.organizationId),
            eq(accounts.type, "ASSET"),
            or(eq(bills.status, "APPROVED"), eq(bills.status, "PART_PAID"), eq(bills.status, "PAID")),
            excludeIds.length > 0 ? notInArray(billLines.id, excludeIds) : undefined,
          ),
        )
        .orderBy(asc(bills.issueDate));

      return rows.map((r) => ({
        billLineId: r.line.id,
        billId: r.bill.id,
        billNumber: r.bill.billNumber,
        supplierName: r.supplier.displayName,
        issueDate: r.bill.issueDate,
        description: r.line.description,
        accountId: r.account.id,
        accountCode: r.account.code,
        accountName: r.account.name,
        lineAmount: r.line.lineAmount,
      }));
    });
  },

  /** Standalone registration — no bill involved (e.g. an opening-balance asset, or one bought by a means this system doesn't model as a bill). Never posts anything; see this module's doc comment. */
  async registerAsset(actor: Actor, input: RegisterFixedAssetInput) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (!input.name.trim()) throw new InvalidFixedAssetError("A name is required.");
      const cost = Money.of(input.acquisitionCost, "X");
      if (!cost.isPositive()) throw new InvalidFixedAssetError("Acquisition cost must be greater than zero.");

      const assetClass = await loadAssetClassOr404(tx, actor.organizationId, input.assetClassId);
      const usefulLifeMonths = input.usefulLifeMonths ?? assetClass.defaultUsefulLifeMonths;
      if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
        throw new InvalidFixedAssetError("Useful life must be a positive whole number of months.");
      }
      const residualValue = input.residualValue ?? "0";
      if (Money.of(residualValue, "X").compareTo(cost) >= 0) {
        throw new InvalidFixedAssetError("Residual value must be less than acquisition cost.");
      }

      await validateAccountWiring(tx, actor.organizationId, input);

      const [created] = await tx
        .insert(fixedAssets)
        .values({
          organizationId: actor.organizationId,
          assetClassId: input.assetClassId,
          name: input.name.trim(),
          description: input.description ?? null,
          acquisitionDate: input.acquisitionDate,
          acquisitionCost: cost.toString(),
          usefulLifeMonths,
          depreciationMethod: input.depreciationMethod ?? assetClass.defaultDepreciationMethod,
          residualValue,
          assetAccountId: input.assetAccountId,
          accumulatedDepreciationAccountId: input.accumulatedDepreciationAccountId,
          depreciationExpenseAccountId: input.depreciationExpenseAccountId,
          locationReference: input.locationReference ?? null,
          serialNumber: input.serialNumber ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to register fixed asset.");

      await AuditService.record(tx, actor, {
        action: "fixed_asset.registered",
        entityType: "FixedAsset",
        entityId: created.id,
        after: { name: created.name, acquisitionCost: created.acquisitionCost, source: "standalone" },
      });

      return created;
    });
  },

  /**
   * Registers an asset from a bill line already flagged as capitalized by
   * the user (coding it to the fixed-asset GL account rather than an
   * expense account). The bill must already be posted (any status other
   * than DRAFT/VOID) — `acquisitionCost`/`acquisitionDate` come straight
   * from the bill line's `lineAmount` (pre-tax) and the bill's `issueDate`,
   * and `assetAccountId` must equal the line's own `accountId` — this
   * function never re-derives or re-posts anything, it only confirms the
   * already-posted debit and the asset register agree, then links them via
   * `sourceBillLineId`.
   */
  async registerFromBillLine(actor: Actor, input: RegisterFixedAssetFromBillLineInput) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (!input.name.trim()) throw new InvalidFixedAssetError("A name is required.");

      const [row] = await tx
        .select({ line: billLines, bill: bills })
        .from(billLines)
        .innerJoin(bills, eq(bills.id, billLines.billId))
        .where(and(eq(billLines.id, input.billLineId), eq(billLines.organizationId, actor.organizationId)));
      if (!row) throw new InvalidAcquisitionSourceError(`Bill line ${input.billLineId} was not found in this organization.`);
      if (row.bill.status === "DRAFT" || row.bill.status === "VOID") {
        throw new InvalidAcquisitionSourceError(
          `Bill ${row.bill.billNumber} is ${row.bill.status} — only a posted bill's line can register an asset.`,
        );
      }
      if (row.line.accountId !== input.assetAccountId) {
        throw new InvalidAcquisitionSourceError(
          `Bill line ${input.billLineId} was coded to a different account than assetAccountId — ` +
            `code the bill line directly to the fixed-asset account before registering it as one.`,
        );
      }

      const existing = await tx
        .select({ id: fixedAssets.id })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.organizationId, actor.organizationId), eq(fixedAssets.sourceBillLineId, input.billLineId)));
      if (existing.length > 0) {
        throw new InvalidAcquisitionSourceError(`Bill line ${input.billLineId} has already registered a fixed asset.`);
      }

      const assetClass = await loadAssetClassOr404(tx, actor.organizationId, input.assetClassId);
      const usefulLifeMonths = input.usefulLifeMonths ?? assetClass.defaultUsefulLifeMonths;
      if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
        throw new InvalidFixedAssetError("Useful life must be a positive whole number of months.");
      }
      const cost = Money.of(row.line.lineAmount, "X");
      const residualValue = input.residualValue ?? "0";
      if (Money.of(residualValue, "X").compareTo(cost) >= 0) {
        throw new InvalidFixedAssetError("Residual value must be less than acquisition cost.");
      }

      await loadAccountOrThrow(tx, actor.organizationId, input.accumulatedDepreciationAccountId, "ASSET", "Accumulated depreciation");
      await loadAccountOrThrow(tx, actor.organizationId, input.depreciationExpenseAccountId, "EXPENSE", "Depreciation expense");

      const [created] = await tx
        .insert(fixedAssets)
        .values({
          organizationId: actor.organizationId,
          assetClassId: input.assetClassId,
          name: input.name.trim(),
          description: input.description ?? null,
          acquisitionDate: row.bill.issueDate,
          acquisitionCost: cost.toString(),
          usefulLifeMonths,
          depreciationMethod: input.depreciationMethod ?? assetClass.defaultDepreciationMethod,
          residualValue,
          assetAccountId: input.assetAccountId,
          accumulatedDepreciationAccountId: input.accumulatedDepreciationAccountId,
          depreciationExpenseAccountId: input.depreciationExpenseAccountId,
          locationReference: input.locationReference ?? null,
          serialNumber: input.serialNumber ?? null,
          sourceBillLineId: input.billLineId,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to register fixed asset.");

      await AuditService.record(tx, actor, {
        action: "fixed_asset.registered",
        entityType: "FixedAsset",
        entityId: created.id,
        after: {
          name: created.name,
          acquisitionCost: created.acquisitionCost,
          source: "bill_line",
          billNumber: row.bill.billNumber,
        },
      });

      return created;
    });
  },

  /**
   * Edits the asset's editable, non-financial fields: name, description,
   * location/serial reference. Deliberately excludes acquisition cost,
   * date, useful life, method, and the GL account wiring — changing any of
   * those after depreciation has started would desynchronize
   * `depreciation_entries`' history; a true correction to one of those is a
   * dispose-and-re-register, or a manual correcting journal, not an edit.
   * Transferring location is this slice's only "transfer" — see
   * docs/roadmap.md for why a full transfer workflow is deferred.
   */
  async updateDetails(
    actor: Actor,
    id: string,
    input: { name: string; description?: string; locationReference?: string; serialNumber?: string },
  ) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadFixedAssetOr404(tx, actor.organizationId, id);
      if (!input.name.trim()) throw new InvalidFixedAssetError("A name is required.");

      const [updated] = await tx
        .update(fixedAssets)
        .set({
          name: input.name.trim(),
          description: input.description ?? null,
          locationReference: input.locationReference ?? null,
          serialNumber: input.serialNumber ?? null,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssets.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "fixed_asset.updated",
        entityType: "FixedAsset",
        entityId: id,
        before: { name: existing.name, locationReference: existing.locationReference },
        after: { name: input.name, locationReference: input.locationReference ?? null },
      });

      return updated;
    });
  },

  /**
   * Sale disposal: removes the asset's full cost and accumulated
   * depreciation from the books and recognizes the difference between
   * `proceeds` and net book value as a gain (credited) or loss (debited) on
   * disposal. One-way and terminal — see `fixedAssetStatusEnum`'s doc
   * comment — a mistaken disposal is corrected with a manual correcting
   * journal, never by editing this event (the same reversal-only discipline
   * `PostingService.reverseEntry` enforces for every other posted entry).
   *
   * Journal (asset-side signs; `debit`/`credit` each default the other to
   * zero as `PostingService` requires):
   * - Debit `proceedsAccountId` for `proceeds` (what was received)
   * - Debit `accumulatedDepreciationAccountId` for the accumulated
   *   depreciation being removed (it carries a credit balance, so removing
   *   it is a debit)
   * - Credit `assetAccountId` for the full `acquisitionCost` (removing the
   *   asset's cost)
   * - The balancing gain/loss line on `gainLossAccountId`: credited if
   *   `proceeds > netBookValue` (a gain), debited if `proceeds <
   *   netBookValue` (a loss)
   */
  async disposeAsset(actor: Actor, id: string, input: DisposeAssetInput) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const asset = await loadFixedAssetOr404(tx, actor.organizationId, id);
      assertActive(asset);

      const proceeds = Money.of(input.proceeds, "X");
      if (proceeds.isNegative()) throw new InvalidDisposalError("Proceeds cannot be negative.");

      await loadAccountOrThrow(tx, actor.organizationId, input.proceedsAccountId, "ASSET", "Proceeds");
      await loadAccountOrThrow(tx, actor.organizationId, input.gainLossAccountId, undefined, "Gain/loss");

      const currency = await baseCurrencyOf(tx, actor.organizationId);
      const cost = Money.of(asset.acquisitionCost, currency);
      const accumulatedDepreciation = Money.of(asset.accumulatedDepreciation, currency);
      const proceedsInCurrency = Money.of(input.proceeds, currency);
      const { netBookValue: netBookValueStr, gainLoss: gainLossStr } = calculateDisposalGainLoss(
        asset.acquisitionCost,
        asset.accumulatedDepreciation,
        input.proceeds,
        currency,
      );
      const netBookValue = Money.of(netBookValueStr, currency);
      const gainLoss = Money.of(gainLossStr, currency);

      const lines: JournalLineDraft[] = [];
      if (proceedsInCurrency.isPositive()) {
        lines.push({ accountId: input.proceedsAccountId, debit: proceedsInCurrency.toString(), currency });
      }
      if (accumulatedDepreciation.isPositive()) {
        lines.push({ accountId: asset.accumulatedDepreciationAccountId, debit: accumulatedDepreciation.toString(), currency });
      }
      lines.push({ accountId: asset.assetAccountId, credit: cost.toString(), currency });
      if (gainLoss.isPositive()) {
        lines.push({ accountId: input.gainLossAccountId, credit: gainLoss.toString(), currency });
      } else if (gainLoss.isNegative()) {
        lines.push({ accountId: input.gainLossAccountId, debit: gainLoss.negate().toString(), currency });
      }
      // gainLoss exactly zero: the three lines above already balance
      // (proceeds + accumulatedDepreciation == cost when proceeds ==
      // netBookValue), so no fourth line is needed or added.

      const posted = await PostingService.postJournal(actor, {
        postingDate: input.disposalDate,
        memo: input.memo ?? `Disposal of fixed asset "${asset.name}"`,
        sourceType: "MANUAL",
        lines,
      });

      const [updated] = await tx
        .update(fixedAssets)
        .set({
          status: "DISPOSED",
          disposedAt: input.disposalDate,
          disposalProceeds: proceedsInCurrency.toString(),
          disposalGainLoss: gainLoss.toString(),
          disposalJournalEntryId: posted.entryId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssets.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "fixed_asset.disposed",
        entityType: "FixedAsset",
        entityId: id,
        before: { status: "ACTIVE" },
        after: {
          status: "DISPOSED",
          proceeds: proceedsInCurrency.toString(),
          netBookValue: netBookValue.toString(),
          gainLoss: gainLoss.toString(),
          journalEntryId: posted.entryId,
        },
      });

      return { ...updated, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /**
   * Write-off: no proceeds — the full remaining net book value is
   * recognized as a loss. Same removal as `disposeAsset`, simplified: debit
   * accumulated depreciation, credit asset cost, and debit `lossAccountId`
   * for the full net book value (there is no proceeds line, and the loss is
   * always exactly the net book value — never a partial figure). One-way
   * and terminal, same as `disposeAsset`.
   */
  async writeOffAsset(actor: Actor, id: string, input: WriteOffAssetInput) {
    assertPermission(actor, "fixed_asset:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const asset = await loadFixedAssetOr404(tx, actor.organizationId, id);
      assertActive(asset);

      await loadAccountOrThrow(tx, actor.organizationId, input.lossAccountId, undefined, "Loss");

      const currency = await baseCurrencyOf(tx, actor.organizationId);
      const cost = Money.of(asset.acquisitionCost, currency);
      const accumulatedDepreciation = Money.of(asset.accumulatedDepreciation, currency);
      const { netBookValue: netBookValueStr } = calculateWriteOffLoss(
        asset.acquisitionCost,
        asset.accumulatedDepreciation,
        currency,
      );
      const netBookValue = Money.of(netBookValueStr, currency);

      const lines: JournalLineDraft[] = [];
      if (accumulatedDepreciation.isPositive()) {
        lines.push({ accountId: asset.accumulatedDepreciationAccountId, debit: accumulatedDepreciation.toString(), currency });
      }
      lines.push({ accountId: asset.assetAccountId, credit: cost.toString(), currency });
      if (netBookValue.isPositive()) {
        lines.push({ accountId: input.lossAccountId, debit: netBookValue.toString(), currency });
      }
      // netBookValue is zero only for an already-fully-depreciated asset
      // (accumulatedDepreciation == cost); the two lines above already
      // balance exactly, so no loss line is needed.

      const posted = await PostingService.postJournal(actor, {
        postingDate: input.disposalDate,
        memo: input.memo ?? `Write-off of fixed asset "${asset.name}"`,
        sourceType: "MANUAL",
        lines,
      });

      const [updated] = await tx
        .update(fixedAssets)
        .set({
          status: "WRITTEN_OFF",
          disposedAt: input.disposalDate,
          disposalProceeds: "0.0000",
          disposalGainLoss: netBookValue.negate().toString(),
          disposalJournalEntryId: posted.entryId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssets.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "fixed_asset.written_off",
        entityType: "FixedAsset",
        entityId: id,
        before: { status: "ACTIVE" },
        after: { status: "WRITTEN_OFF", netBookValueWrittenOff: netBookValue.toString(), journalEntryId: posted.entryId },
      });

      return { ...updated, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },
};
