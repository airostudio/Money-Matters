import { eq } from "drizzle-orm";
import { cashForecastSettings } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { Money } from "@/domain/money/money";
import { InvalidForecastSettingError } from "./errors";

/** The documented default when an organization has never set a threshold: warn only if projected cash goes below zero. */
export const DEFAULT_LOW_CASH_THRESHOLD = "0.0000";

export async function loadLowCashThreshold(tx: TenantDb, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ lowCashThreshold: cashForecastSettings.lowCashThreshold })
    .from(cashForecastSettings)
    .where(eq(cashForecastSettings.organizationId, organizationId));
  return row?.lowCashThreshold ?? DEFAULT_LOW_CASH_THRESHOLD;
}

/**
 * The org-level low-cash threshold the forecast warns against (master spec
 * §6's "Cash Warning"). Reading needs `forecast:read`; changing it is an
 * audited mutation needing `forecast:manage`. A threshold is a deliberate
 * user setting, never inferred — the default of zero means "warn only if
 * projected cash would go negative".
 */
export const ForecastSettingsService = {
  async get(actor: Actor): Promise<{ lowCashThreshold: string }> {
    assertPermission(actor, "forecast:read");
    return withTenant(actor.organizationId, async (tx) => ({
      lowCashThreshold: await loadLowCashThreshold(tx, actor.organizationId),
    }));
  },

  async setLowCashThreshold(actor: Actor, threshold: string): Promise<{ lowCashThreshold: string }> {
    assertPermission(actor, "forecast:manage");
    let value: Money;
    try {
      value = Money.of(threshold.trim(), "XXX");
    } catch {
      throw new InvalidForecastSettingError("The low-cash threshold must be a number.");
    }
    if (!value.toDecimal().isFinite()) {
      throw new InvalidForecastSettingError("The low-cash threshold must be a number.");
    }
    if (value.isNegative()) {
      throw new InvalidForecastSettingError("The low-cash threshold cannot be negative.");
    }

    return withTenant(actor.organizationId, async (tx) => {
      const before = await loadLowCashThreshold(tx, actor.organizationId);
      const [existing] = await tx
        .select({ id: cashForecastSettings.id })
        .from(cashForecastSettings)
        .where(eq(cashForecastSettings.organizationId, actor.organizationId));

      if (existing) {
        await tx
          .update(cashForecastSettings)
          .set({ lowCashThreshold: value.toString(), updatedAt: new Date(), updatedById: actor.userId })
          .where(eq(cashForecastSettings.id, existing.id));
      } else {
        await tx.insert(cashForecastSettings).values({
          organizationId: actor.organizationId,
          lowCashThreshold: value.toString(),
          updatedById: actor.userId,
        });
      }

      await AuditService.record(tx, actor, {
        action: "cash_forecast_settings.low_cash_threshold_changed",
        entityType: "CashForecastSettings",
        entityId: actor.organizationId,
        before: { lowCashThreshold: before },
        after: { lowCashThreshold: value.toString() },
      });

      return { lowCashThreshold: value.toString() };
    });
  },
};
