import { eq } from "drizzle-orm";
import { fixedAssetClasses, fixedAssets, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { sumPostedActivityByAccount } from "@/domain/ledger/gl-aggregation";
import { normalSignedBalance } from "@/domain/reporting/financial-statements";
import { loadFixedAssetOr404 } from "./fixed-asset-service";
import { projectDepreciationSchedule, type DepreciationScheduleRow } from "./depreciation-calculations";
import type { FixedAssetAccountReconciliation, FixedAssetRegisterReport, FixedAssetRegisterRow } from "./types";

/**
 * The Fixed Asset Register (master spec §28): every asset, its cost,
 * accumulated depreciation, and net book value — and, in aggregate, **the
 * same correctness check** `InventoryValuationService` performs for
 * inventory and `financial-statements.ts`'s Balance Sheet equation check
 * performs for the whole ledger (see `docs/accounting-engine.md` §8/§10):
 * the register's own `acquisitionCost - accumulatedDepreciation` total,
 * grouped by the (asset account, accumulated-depreciation account) pair
 * each asset posts to, compared against those two accounts' own posted GL
 * balances. Since `FixedAssetService` never posts the acquisition itself
 * (see its doc comment) and `DepreciationService`/`disposeAsset`/
 * `writeOffAsset` always update `accumulatedDepreciation` in the same
 * transaction as the journal that changes the matching GL balance, the two
 * numbers are independent paths to the same fact and should always agree
 * exactly — a non-zero `difference` means a bill was coded to the wrong
 * account, an asset was registered against the wrong account pair, or a
 * mutation updated one side without the other, never a rounding footnote
 * to paper over.
 *
 * DISPOSED/WRITTEN_OFF assets are excluded from the register and the
 * reconciliation (their cost/depreciation has already been fully removed
 * from both the register and the GL by the disposal/write-off journal, so
 * including them would double-count against the now-zero GL balance they
 * left behind).
 */
export const FixedAssetRegisterService = {
  async getRegister(actor: Actor, asOfDate: Date = new Date()): Promise<FixedAssetRegisterReport> {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.organizationId));
      const currency = org?.baseCurrency ?? "AUD";

      const rows = await tx
        .select({ asset: fixedAssets, assetClass: fixedAssetClasses })
        .from(fixedAssets)
        .innerJoin(fixedAssetClasses, eq(fixedAssetClasses.id, fixedAssets.assetClassId))
        .where(eq(fixedAssets.organizationId, actor.organizationId));

      const active = rows.filter((r) => r.asset.status === "ACTIVE");

      const assetRows: FixedAssetRegisterRow[] = active.map((r) => {
        const cost = Money.of(r.asset.acquisitionCost, currency);
        const accumulated = Money.of(r.asset.accumulatedDepreciation, currency);
        return {
          assetId: r.asset.id,
          name: r.asset.name,
          assetClassName: r.assetClass.name,
          status: r.asset.status,
          acquisitionDate: r.asset.acquisitionDate.toISOString().slice(0, 10),
          acquisitionCost: cost.toString(),
          accumulatedDepreciation: accumulated.toString(),
          netBookValue: cost.subtract(accumulated).toString(),
          assetAccountId: r.asset.assetAccountId,
          accumulatedDepreciationAccountId: r.asset.accumulatedDepreciationAccountId,
        };
      });

      const totalNetBookValue = assetRows.reduce(
        (sum, r) => sum.add(Money.of(r.netBookValue, currency)),
        Money.zero(currency),
      );

      // Group by (asset account, accumulated-depreciation account) pair —
      // several assets may legitimately share one (e.g. one "Motor
      // Vehicles" cost/accumulated-depreciation pair for a whole fleet),
      // same spirit as InventoryValuationService grouping by
      // inventoryAssetAccountId.
      const pairKey = (assetAccountId: string, accDepAccountId: string) => `${assetAccountId}::${accDepAccountId}`;
      const registerByPair = new Map<string, { assetAccountId: string; accDepAccountId: string; nbv: Money }>();
      for (const row of assetRows) {
        const key = pairKey(row.assetAccountId, row.accumulatedDepreciationAccountId);
        const running = registerByPair.get(key)?.nbv ?? Money.zero(currency);
        registerByPair.set(key, {
          assetAccountId: row.assetAccountId,
          accDepAccountId: row.accumulatedDepreciationAccountId,
          nbv: running.add(Money.of(row.netBookValue, currency)),
        });
      }

      const glRows = await sumPostedActivityByAccount(tx, actor.organizationId, { to: asOfDate });
      const glByAccount = new Map(glRows.map((g) => [g.accountId, g]));

      const reconciliation: FixedAssetAccountReconciliation[] = [...registerByPair.values()].map((pair) => {
        const assetGlRow = glByAccount.get(pair.assetAccountId);
        const accDepGlRow = glByAccount.get(pair.accDepAccountId);
        const assetGlBalance = assetGlRow ? normalSignedBalance(assetGlRow, currency) : Money.zero(currency);
        const accDepGlBalance = accDepGlRow ? normalSignedBalance(accDepGlRow, currency) : Money.zero(currency);
        const glNetBookValue = assetGlBalance.add(accDepGlBalance);
        const difference = pair.nbv.subtract(glNetBookValue);

        return {
          assetAccountId: pair.assetAccountId,
          assetAccountCode: assetGlRow?.code ?? "",
          assetAccountName: assetGlRow?.name ?? "",
          accumulatedDepreciationAccountId: pair.accDepAccountId,
          accumulatedDepreciationAccountName: accDepGlRow?.name ?? "",
          registerNetBookValue: pair.nbv.toString(),
          assetAccountGlBalance: assetGlBalance.toString(),
          accumulatedDepreciationGlBalance: accDepGlBalance.toString(),
          glNetBookValue: glNetBookValue.toString(),
          difference: difference.toString(),
          reconciled: difference.isZero(),
        };
      });

      return {
        currency,
        assets: assetRows,
        totalNetBookValue: totalNetBookValue.toString(),
        reconciliation,
        fullyReconciled: reconciliation.every((r) => r.reconciled),
      };
    });
  },

  /**
   * The per-asset depreciation schedule (master spec §28): every period
   * already run (from `depreciation_entries`, the real history) followed
   * by every period still projected from here to the end of the asset's
   * useful life (`projectDepreciationSchedule`, pure arithmetic — see that
   * function's doc comment). Refused for a DISPOSED/WRITTEN_OFF asset,
   * whose remaining schedule is meaningless once its cost has left the
   * books.
   */
  async getDepreciationSchedule(actor: Actor, assetId: string): Promise<DepreciationScheduleRow[]> {
    assertPermission(actor, "fixed_asset:read");
    return withTenant(actor.organizationId, async (tx) => {
      const asset = await loadFixedAssetOr404(tx, actor.organizationId, assetId);
      return projectDepreciationSchedule({
        acquisitionDate: asset.acquisitionDate,
        acquisitionCost: asset.acquisitionCost,
        residualValue: asset.residualValue,
        usefulLifeMonths: asset.usefulLifeMonths,
      });
    });
  },
};
