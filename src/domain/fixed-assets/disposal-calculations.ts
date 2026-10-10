import { Money } from "@/domain/money/money";

/**
 * Pure, DB-free disposal/write-off arithmetic — the fixed-assets mirror of
 * `depreciation-calculations.ts`, used by `FixedAssetService.disposeAsset`/
 * `writeOffAsset`. No database access, exercised directly by unit tests.
 */

export interface DisposalGainLoss {
  /** Decimal string — `acquisitionCost - accumulatedDepreciation` immediately before disposal. */
  netBookValue: string;
  /** Signed decimal string: `proceeds - netBookValue`. Positive = gain, negative = loss, zero = neither. */
  gainLoss: string;
}

/** A sale disposal: proceeds compared against net book value. See `FixedAssetService.disposeAsset`'s doc comment for the resulting journal. */
export function calculateDisposalGainLoss(
  acquisitionCost: string,
  accumulatedDepreciation: string,
  proceeds: string,
  currency = "X",
): DisposalGainLoss {
  const cost = Money.of(acquisitionCost, currency);
  const accumulated = Money.of(accumulatedDepreciation, currency);
  const netBookValue = cost.subtract(accumulated);
  const gainLoss = Money.of(proceeds, currency).subtract(netBookValue);
  return { netBookValue: netBookValue.toString(), gainLoss: gainLoss.toString() };
}

/** A write-off: no proceeds, so the loss is always exactly the remaining net book value. See `FixedAssetService.writeOffAsset`'s doc comment for the resulting journal. */
export function calculateWriteOffLoss(
  acquisitionCost: string,
  accumulatedDepreciation: string,
  currency = "X",
): { netBookValue: string; loss: string } {
  const cost = Money.of(acquisitionCost, currency);
  const accumulated = Money.of(accumulatedDepreciation, currency);
  const netBookValue = cost.subtract(accumulated);
  return { netBookValue: netBookValue.toString(), loss: netBookValue.toString() };
}
