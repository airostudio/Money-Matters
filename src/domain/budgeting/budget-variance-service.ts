import { and, eq, gte, lte } from "drizzle-orm";
import { accounts, budgetLines, organizations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { Money } from "@/domain/money/money";
import { normalSignedBalance } from "@/domain/reporting/financial-statements";
import { sumPostedActivityByAccount } from "@/domain/ledger/gl-aggregation";
import type { PeriodRange } from "@/domain/reporting/reporting-service";
import { buildBudgetVarianceReport, type BudgetVarianceReport } from "./budget-variance-calculations";
import { loadBudgetOr404 } from "./budget-service";

async function loadOrgCurrency(tx: TenantDb, organizationId: string): Promise<string> {
  const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.baseCurrency ?? "AUD";
}

/**
 * Budget vs. Actual (master spec §35/§36): structurally a P&L-shaped
 * report with a second column sourced from `budget_lines` instead of a
 * comparison period — built alongside `ReportingService` rather than
 * inside it, but reusing its exact same building blocks: the actual side
 * is `sumPostedActivityByAccount`, the same shared aggregation every other
 * financial statement uses (never a parallel GL query path), and amounts
 * are normal-balance-signed via the same `normalSignedBalance` helper
 * `financial-statements.ts` uses throughout.
 *
 * Scoped to REVENUE/EXPENSE accounts only, matching the P&L shape this
 * slice's brief asks for explicitly ("Budget vs. Actual reporting ... is
 * structurally a P&L-shaped report") — a budget line against an
 * ASSET/LIABILITY/EQUITY account (e.g. a capex budget) is still stored and
 * reportable by querying `budget_lines` directly, but this report doesn't
 * surface it, the same deliberate scope `buildProfitAndLoss` uses for its
 * own revenue/expense-only sections.
 */
export const BudgetVarianceService = {
  async getBudgetVsActual(
    actor: Actor,
    budgetId: string,
    period: PeriodRange,
    dimensionValueId?: string,
  ): Promise<BudgetVarianceReport> {
    assertPermission(actor, "budget:read");
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const budget = await loadBudgetOr404(tx, actor.organizationId, budgetId);
      const currency = await loadOrgCurrency(tx, actor.organizationId);

      const actualRows = await sumPostedActivityByAccount(tx, actor.organizationId, { ...period, dimensionValueId });
      const relevantActualRows = actualRows.filter((r) => r.type === "REVENUE" || r.type === "EXPENSE");

      const actualByAccount = new Map<string, string>();
      for (const row of relevantActualRows) {
        const signed = normalSignedBalance(row, currency);
        if (!signed.isZero()) actualByAccount.set(row.accountId, signed.toString());
      }

      const budgetLineConditions = [
        eq(budgetLines.organizationId, actor.organizationId),
        eq(budgetLines.budgetId, budgetId),
        gte(budgetLines.periodStart, period.from),
        lte(budgetLines.periodEnd, period.to),
      ];
      if (dimensionValueId) budgetLineConditions.push(eq(budgetLines.dimensionValueId, dimensionValueId));

      const budgetRows = await tx
        .select({ accountId: budgetLines.accountId, amount: budgetLines.amount })
        .from(budgetLines)
        .where(and(...budgetLineConditions));

      const budgetByAccount = new Map<string, Money>();
      for (const row of budgetRows) {
        const existing = budgetByAccount.get(row.accountId) ?? Money.zero(currency);
        budgetByAccount.set(row.accountId, existing.add(Money.of(row.amount, currency)));
      }
      const budgetByAccountStr = new Map([...budgetByAccount.entries()].map(([id, m]) => [id, m.toString()]));

      const accountIds = new Set<string>([...actualByAccount.keys(), ...budgetByAccountStr.keys()]);
      const accountRows =
        accountIds.size === 0
          ? []
          : await tx
              .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subType: accounts.subType })
              .from(accounts)
              .where(eq(accounts.organizationId, actor.organizationId));
      const relevantAccounts = accountRows
        .filter((a) => accountIds.has(a.id))
        .map((a) => ({ accountId: a.id, code: a.code, name: a.name, type: a.type, subType: a.subType }));

      const report = buildBudgetVarianceReport(relevantAccounts, budgetByAccountStr, actualByAccount, currency);
      return { ...report, budgetId: budget.id, budgetName: budget.name };
    });
  },
};
