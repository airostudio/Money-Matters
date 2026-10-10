import "server-only";
import type { Actor } from "@/domain/permissions/permission-service";
import { AccountService } from "@/domain/accounts/account-service";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { ProductService } from "@/domain/inventory/product-service";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import type { ScenarioFormOptions } from "@/components/forecasting/scenario-form-fields";

/**
 * The pick-lists the scenario form needs. Each source is read with the
 * actor's own permissions and silently degrades to an empty list for a role
 * that lacks it (the form still works — it just offers fewer choices), the
 * same discipline the AI Controller applies to `dimension:read`. Sequential,
 * not parallel (see `DailyFinanceBriefService.generate`).
 */
export async function loadScenarioFormOptions(actor: Actor): Promise<ScenarioFormOptions> {
  const customers = await ScenarioService.listCustomerRevenue(actor).catch(() => []);
  const products = await ProductService.list(actor, { isActive: true })
    .then((rows) => rows.map((p) => ({ id: p.id, name: `${p.sku} ${p.name}` })))
    .catch(() => []);
  const revenueAccounts = await AccountService.list(actor)
    .then((rows) => rows.filter((a) => a.type === "REVENUE").map((a) => ({ id: a.id, code: a.code, name: a.name })))
    .catch(() => []);
  const budgets = await BudgetService.list(actor, { status: "ACTIVE" })
    .then((rows) => rows.map((b) => ({ id: b.id, name: b.name })))
    .catch(() => []);
  const suggestedOnCost = await ScenarioService.suggestedHireOnCost();
  return { customers, products, revenueAccounts, budgets, suggestedOnCost };
}
