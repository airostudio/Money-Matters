import type { depreciationMethodEnum, fixedAssetStatusEnum } from "@/db/schema";

export type DepreciationMethod = (typeof depreciationMethodEnum.enumValues)[number];
export type FixedAssetStatus = (typeof fixedAssetStatusEnum.enumValues)[number];

export interface CreateFixedAssetClassInput {
  name: string;
  defaultDepreciationMethod?: DepreciationMethod;
  defaultUsefulLifeMonths: number;
}

export type UpdateFixedAssetClassInput = CreateFixedAssetClassInput;

/** Common fields for both registration paths — see `FixedAssetService.registerAsset`/`registerFromBillLine`. */
interface RegisterFixedAssetCommonInput {
  assetClassId: string;
  name: string;
  description?: string;
  /** Overrides the asset class's default — see `fixedAssetClasses`' doc comment. */
  usefulLifeMonths?: number;
  depreciationMethod?: DepreciationMethod;
  /** Decimal string. Defaults to "0". */
  residualValue?: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  locationReference?: string;
  serialNumber?: string;
}

export interface RegisterFixedAssetInput extends RegisterFixedAssetCommonInput {
  acquisitionDate: Date;
  /** Decimal string. */
  acquisitionCost: string;
}

export interface RegisterFixedAssetFromBillLineInput extends RegisterFixedAssetCommonInput {
  billLineId: string;
}

export interface RunDepreciationInput {
  /** Any date within the calendar month to depreciate — the service derives that month's first/last day. */
  periodMonth: Date;
  /** Restrict the run to one asset instead of every ACTIVE asset — used by tests and by a "catch this one asset up" action. Omit to run the whole organization. */
  assetId?: string;
}

export interface DepreciationRunLineResult {
  assetId: string;
  assetName: string;
  /** Decimal string — "0.0000" when this asset wasn't yet acquired or is already fully depreciated this period (still recorded, for idempotency, but not posted). */
  amount: string;
  accumulatedDepreciationAfter: string;
}

export interface DepreciationRunResult {
  periodStart: string;
  periodEnd: string;
  lines: DepreciationRunLineResult[];
  /** Null when every line's amount was "0.0000" — nothing to post. */
  journalEntryId: string | null;
  entryNumber: string | null;
  /** Decimal string — the sum of every non-zero line, i.e. the posted journal's total. "0.0000" when nothing was posted. */
  totalPosted: string;
}

export interface DisposeAssetInput {
  disposalDate: Date;
  /** Decimal string — cash/other consideration received. */
  proceeds: string;
  /** The account proceeds are debited to (e.g. a bank/clearing account) — never re-derived, since this slice doesn't model the cash receipt itself as a separate payment. */
  proceedsAccountId: string;
  /** Credited for a gain, debited for a loss. */
  gainLossAccountId: string;
  memo?: string;
}

export interface WriteOffAssetInput {
  disposalDate: Date;
  /** The expense/loss account debited for the full remaining net book value. */
  lossAccountId: string;
  memo?: string;
}

export interface FixedAssetRegisterRow {
  assetId: string;
  name: string;
  assetClassName: string;
  status: FixedAssetStatus;
  acquisitionDate: string;
  /** Decimal string. */
  acquisitionCost: string;
  /** Decimal string. */
  accumulatedDepreciation: string;
  /** acquisitionCost - accumulatedDepreciation, decimal string. */
  netBookValue: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
}

export interface FixedAssetAccountReconciliation {
  assetAccountId: string;
  assetAccountCode: string;
  assetAccountName: string;
  accumulatedDepreciationAccountId: string;
  accumulatedDepreciationAccountName: string;
  /** Sum of `acquisitionCost - accumulatedDepreciation` across every ACTIVE asset posting to this account pair. */
  registerNetBookValue: string;
  /** The asset account's own posted GL balance, normal-signed. */
  assetAccountGlBalance: string;
  /** The accumulated-depreciation account's own posted GL balance, normal-signed (negative, by the contra-asset convention — see `fixedAssets.accumulatedDepreciationAccountId`'s doc comment). */
  accumulatedDepreciationGlBalance: string;
  /** assetAccountGlBalance + accumulatedDepreciationGlBalance. */
  glNetBookValue: string;
  /** registerNetBookValue - glNetBookValue. Non-zero is a real bug, never a rounding footnote — see `FixedAssetRegisterService`'s doc comment. */
  difference: string;
  reconciled: boolean;
}

export interface FixedAssetRegisterReport {
  currency: string;
  assets: FixedAssetRegisterRow[];
  totalNetBookValue: string;
  reconciliation: FixedAssetAccountReconciliation[];
  fullyReconciled: boolean;
}
