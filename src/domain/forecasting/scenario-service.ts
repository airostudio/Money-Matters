import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accounts,
  budgetLines,
  budgets,
  contacts,
  inventoryMovements,
  invoiceLines,
  invoices,
  scenarios,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { AuditService } from "@/domain/audit/audit-service";
import { Money } from "@/domain/money/money";
import { sumPostedActivityByAccount } from "@/domain/ledger/gl-aggregation";
import { normalSignedBalance } from "@/domain/reporting/financial-statements";
import { loadCashPosition } from "@/domain/reporting/cash-position";
import { loadAllocatedTotal } from "@/domain/sales/invoice-service";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { TaxRuleService } from "@/domain/payroll/tax-rule-service";
import { CashForecastService } from "./cash-forecast-service";
import { dateKey, startOfUtcDay } from "./forecast-calculations";
import { InvalidScenarioError, ScenarioBaselineUnavailableError, ScenarioNotFoundError } from "./errors";
import {
  assembleCase,
  CASE_NAMES,
  clampedShare,
  hireDeltas,
  hireMonthlyCost,
  loseCustomerDeltas,
  monthLabel,
  priceChangeDeltas,
  projectionMonths,
  revenuePercentForCase,
  volumeForCase,
  type BaselineMonth,
  type CaseAssumption,
  type CaseName,
  type ScenarioCaseResult,
} from "./scenario-calculations";
import {
  parseScenarioParams,
  type BaselineSource,
  type ScenarioParams,
  type ScenarioType,
} from "./scenario-parameters";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScenarioRecord {
  id: string;
  name: string;
  type: ScenarioType;
  parameters: ScenarioParams["params"];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DerivedInput {
  label: string;
  value: string;
  note?: string;
}

export interface ScenarioRunResult {
  scenarioId: string | null;
  name: string;
  type: ScenarioType;
  asOf: string;
  currency: string;
  parameters: ScenarioParams["params"];
  baseline: {
    source: "ACTUALS" | "BUDGET";
    label: string;
    openingCash: string;
    months: Array<{ month: string; revenue: string; expenses: string }>;
    warnings: string[];
  };
  /** Figures derived from real data (trailing-12-month shares, attributable cost, open receivables) — shown so the user can see exactly what the maths started from. */
  derivedInputs: DerivedInput[];
  /** Type-specific headline numbers (e.g. the hire's fully loaded monthly cost). */
  keyFigures: DerivedInput[];
  cases: Record<CaseName, ScenarioCaseResult>;
  /** The cash forecast's near-term (90-day) view, shown beside the 12-month run-rate comparison. Null when the actor can't read forecasts or the caller opted out. */
  forecastContext: {
    horizon: "90D";
    knownOnlyLowPoint: { date: string; balance: string };
    withStatisticalLowPoint: { date: string; balance: string };
    knownOnlyEnd: string;
    withStatisticalEnd: string;
    warningMessage: string | null;
    payrollOmitted: boolean;
  } | null;
  caveats: string[];
}

export interface RunScenarioOptions {
  asOfDate?: Date;
  /** Default true. */
  includeForecastContext?: boolean;
}

const SCENARIO_CAVEATS = [
  "Best / Expected / Worst differ only by the explicit assumptions listed under each case. They are modelling assumptions you can edit, not predictions.",
  "Cash is a run-rate path (opening cash + cumulative monthly net profit) over the next 12 full calendar months. It is not a working-capital model: invoice and bill timing are not modelled here — see the Cash Forecast for the day-by-day near-term view.",
  "This is analysis only. Nothing here is posted to the ledger.",
];

function round2(d: Decimal): string {
  return d.toDecimalPlaces(2).toFixed(2);
}

// ---------------------------------------------------------------------------
// Baseline + share data (one transaction, a handful of sequential queries)
// ---------------------------------------------------------------------------

interface RevenueRow {
  customerId: string;
  productId: string | null;
  accountId: string;
  revenue: Money;
  cost: Money;
}

async function loadBaselineMonths(
  tx: TenantDb,
  organizationId: string,
  baseline: BaselineSource,
  asOf: Date,
  months: Date[],
  currency: string,
  resolvedBudgetId: string | null,
): Promise<{ months: BaselineMonth[]; label: string; warnings: string[] }> {
  const warnings: string[] = [];

  if (baseline.source === "ACTUALS") {
    const n = baseline.trailingMonths;
    const thisMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    const from = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - n, 1));
    const to = new Date(thisMonth.getTime() - DAY_MS);
    const rows = await sumPostedActivityByAccount(tx, organizationId, { from, to });
    let revenue = Money.zero(currency);
    let expenses = Money.zero(currency);
    for (const r of rows) {
      if (r.type === "REVENUE") revenue = revenue.add(normalSignedBalance(r, currency));
      else if (r.type === "EXPENSE") expenses = expenses.add(normalSignedBalance(r, currency));
    }
    const monthlyRevenue = Money.of(revenue.toDecimal().div(n), currency);
    const monthlyExpenses = Money.of(expenses.toDecimal().div(n), currency);
    if (!revenue.isPositive()) warnings.push(`No posted revenue in the trailing ${n} full month(s) (${dateKey(from)} to ${dateKey(to)}) — the baseline revenue is zero.`);
    return {
      months: months.map((monthStart) => ({ monthStart, revenue: monthlyRevenue, expenses: monthlyExpenses })),
      label: `Average of the last ${n} full calendar month(s) of posted activity (${dateKey(from)} to ${dateKey(to)}), held flat`,
      warnings,
    };
  }

  const budgetId = resolvedBudgetId!;
  const [budget] = await tx.select().from(budgets).where(and(eq(budgets.id, budgetId), eq(budgets.organizationId, organizationId)));
  const lastMonth = months[months.length - 1]!;
  const windowEnd = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0));
  const lines = await tx
    .select({ periodStart: budgetLines.periodStart, amount: budgetLines.amount, type: accounts.type })
    .from(budgetLines)
    .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
    .where(
      and(
        eq(budgetLines.organizationId, organizationId),
        eq(budgetLines.budgetId, budgetId),
        gte(budgetLines.periodStart, months[0]!),
        lte(budgetLines.periodStart, windowEnd),
      ),
    );
  const byMonth = new Map<string, { revenue: Money; expenses: Money; hasLines: boolean }>();
  for (const l of lines) {
    const key = monthLabel(l.periodStart);
    const slot = byMonth.get(key) ?? { revenue: Money.zero(currency), expenses: Money.zero(currency), hasLines: false };
    if (l.type === "REVENUE") slot.revenue = slot.revenue.add(Money.of(l.amount, currency));
    else if (l.type === "EXPENSE") slot.expenses = slot.expenses.add(Money.of(l.amount, currency));
    slot.hasLines = true;
    byMonth.set(key, slot);
  }
  const missing: string[] = [];
  const out = months.map((monthStart) => {
    const slot = byMonth.get(monthLabel(monthStart));
    if (!slot) missing.push(monthLabel(monthStart));
    return { monthStart, revenue: slot?.revenue ?? Money.zero(currency), expenses: slot?.expenses ?? Money.zero(currency) };
  });
  if (missing.length > 0) warnings.push(`The budget has no revenue/expense lines for: ${missing.join(", ")} — those months are treated as zero.`);
  return { months: out, label: `Budget "${budget?.name ?? budgetId}"`, warnings };
}

async function loadRevenueRows(tx: TenantDb, organizationId: string, from: Date, to: Date, currency: string): Promise<RevenueRow[]> {
  const where = and(
    eq(invoices.organizationId, organizationId),
    ne(invoices.status, "DRAFT"),
    ne(invoices.status, "VOID"),
    gte(invoices.issueDate, from),
    lte(invoices.issueDate, to),
  );
  const revenueRows = await tx
    .select({
      customerId: invoices.customerContactId,
      productId: invoiceLines.productId,
      accountId: invoiceLines.accountId,
      revenue: sql<string>`coalesce(sum(${invoiceLines.lineAmount}), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(where)
    .groupBy(invoices.customerContactId, invoiceLines.productId, invoiceLines.accountId);

  // Cost of sales actually attributable: tracked-inventory SALE movements recorded against these invoice lines.
  const costRows = await tx
    .select({
      customerId: invoices.customerContactId,
      productId: invoiceLines.productId,
      accountId: invoiceLines.accountId,
      cost: sql<string>`coalesce(sum(-${inventoryMovements.totalValue}), 0)`,
    })
    .from(inventoryMovements)
    .innerJoin(invoiceLines, eq(invoiceLines.id, inventoryMovements.invoiceLineId))
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(where, eq(inventoryMovements.movementType, "SALE")))
    .groupBy(invoices.customerContactId, invoiceLines.productId, invoiceLines.accountId);

  const key = (c: string, p: string | null, a: string) => `${c}|${p ?? ""}|${a}`;
  const costByKey = new Map(costRows.map((r) => [key(r.customerId, r.productId, r.accountId), Money.of(r.cost, currency)]));
  return revenueRows.map((r) => ({
    customerId: r.customerId,
    productId: r.productId,
    accountId: r.accountId,
    revenue: Money.of(r.revenue, currency),
    cost: costByKey.get(key(r.customerId, r.productId, r.accountId)) ?? Money.zero(currency),
  }));
}

function sumRows(rows: RevenueRow[], currency: string): { revenue: Money; cost: Money } {
  return {
    revenue: rows.reduce((s, r) => s.add(r.revenue), Money.zero(currency)),
    cost: rows.reduce((s, r) => s.add(r.cost), Money.zero(currency)),
  };
}

function costPercent(revenue: Money, cost: Money): string {
  return revenue.isPositive() ? round2(cost.toDecimal().div(revenue.toDecimal()).times(100)) : "0.00";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function toRecord(row: typeof scenarios.$inferSelect): ScenarioRecord {
  const parsed = parseScenarioParams(row.type, row.parameters);
  if (!parsed.ok) {
    throw new InvalidScenarioError(`Saved scenario "${row.name}" has invalid parameters: ${parsed.error}`);
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    parameters: parsed.value.params,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidScenarioError("A scenario needs a name.");
  if (trimmed.length > 120) throw new InvalidScenarioError("A scenario name can be at most 120 characters.");
  return trimmed;
}

function validateParams(type: ScenarioType, raw: unknown): ScenarioParams {
  const parsed = parseScenarioParams(type, raw);
  if (!parsed.ok) throw new InvalidScenarioError(parsed.error);
  return parsed.value;
}

/**
 * Master spec §37's scenario modelling: a closed set of three typed
 * what-ifs (hire, price change, lose a customer), each producing Best /
 * Expected / Worst against an unmodified baseline. Scenarios are saved
 * QUERIES (name + type + validated parameters), re-run against fresh ledger
 * data every time — never a stored result — and never touch the ledger:
 * there is no `PostingService` call in this domain.
 *
 * **Sequential DB discipline** — see `DailyFinanceBriefService.generate`:
 * `run` does cash position (2 checkouts), one baseline/share transaction, and
 * (optionally) the 90-day forecast context, one after another.
 */
export const ScenarioService = {
  async list(actor: Actor): Promise<ScenarioRecord[]> {
    assertPermission(actor, "scenario:read");
    const rows = await withTenant(actor.organizationId, (tx) =>
      tx.select().from(scenarios).where(eq(scenarios.organizationId, actor.organizationId)).orderBy(desc(scenarios.updatedAt)),
    );
    // A saved row with parameters that no longer validate is skipped from the list view rather than breaking it.
    const out: ScenarioRecord[] = [];
    for (const row of rows) {
      try {
        out.push(toRecord(row));
      } catch {
        // surfaced when opened directly
      }
    }
    return out;
  },

  async get(actor: Actor, id: string): Promise<ScenarioRecord | null> {
    assertPermission(actor, "scenario:read");
    const [row] = await withTenant(actor.organizationId, (tx) =>
      tx.select().from(scenarios).where(and(eq(scenarios.id, id), eq(scenarios.organizationId, actor.organizationId))),
    );
    return row ? toRecord(row) : null;
  },

  async create(actor: Actor, input: { name: string; type: ScenarioType; parameters: unknown; notes?: string }): Promise<ScenarioRecord> {
    assertPermission(actor, "scenario:manage");
    const name = validateName(input.name);
    const validated = validateParams(input.type, input.parameters);
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .insert(scenarios)
        .values({
          organizationId: actor.organizationId,
          name,
          type: input.type,
          parameters: validated.params,
          notes: input.notes?.trim() || null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create scenario.");
      await AuditService.record(tx, actor, {
        action: "scenario.created",
        entityType: "Scenario",
        entityId: row.id,
        after: { name, type: input.type, parameters: validated.params },
      });
      return toRecord(row);
    });
  },

  async update(actor: Actor, id: string, input: { name?: string; parameters?: unknown; notes?: string | null }): Promise<ScenarioRecord> {
    assertPermission(actor, "scenario:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx.select().from(scenarios).where(and(eq(scenarios.id, id), eq(scenarios.organizationId, actor.organizationId)));
      if (!existing) throw new ScenarioNotFoundError(id);

      const name = input.name !== undefined ? validateName(input.name) : existing.name;
      const validated = input.parameters !== undefined ? validateParams(existing.type, input.parameters) : null;
      const [row] = await tx
        .update(scenarios)
        .set({
          name,
          parameters: validated ? validated.params : existing.parameters,
          notes: input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
          updatedAt: new Date(),
          updatedById: actor.userId,
        })
        .where(eq(scenarios.id, id))
        .returning();
      if (!row) throw new Error("Failed to update scenario.");
      await AuditService.record(tx, actor, {
        action: "scenario.updated",
        entityType: "Scenario",
        entityId: id,
        before: { name: existing.name, parameters: existing.parameters },
        after: { name, parameters: row.parameters },
      });
      return toRecord(row);
    });
  },

  async delete(actor: Actor, id: string): Promise<void> {
    assertPermission(actor, "scenario:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx.select().from(scenarios).where(and(eq(scenarios.id, id), eq(scenarios.organizationId, actor.organizationId)));
      if (!existing) throw new ScenarioNotFoundError(id);
      await tx.delete(scenarios).where(eq(scenarios.id, id));
      await AuditService.record(tx, actor, {
        action: "scenario.deleted",
        entityType: "Scenario",
        entityId: id,
        before: { name: existing.name, type: existing.type, parameters: existing.parameters },
      });
    });
  },

  /** Re-runs a SAVED scenario against fresh data. */
  async run(actor: Actor, id: string, options: RunScenarioOptions = {}): Promise<ScenarioRunResult> {
    assertPermission(actor, "scenario:read");
    const record = await ScenarioService.get(actor, id).then((r) => {
      if (!r) throw new ScenarioNotFoundError(id);
      return r;
    });
    return runScenario(actor, { scenarioId: record.id, name: record.name, spec: { type: record.type, params: record.parameters } as ScenarioParams }, options);
  },

  /** Runs unsaved parameters (a form preview) — same validation, same maths, nothing persisted. */
  async preview(actor: Actor, type: ScenarioType, rawParameters: unknown, options: RunScenarioOptions = {}): Promise<ScenarioRunResult> {
    assertPermission(actor, "scenario:read");
    const spec = validateParams(type, rawParameters);
    return runScenario(actor, { scenarioId: null, name: "Unsaved scenario", spec }, options);
  },

  /**
   * The verified Superannuation Guarantee rate from Phase 8's effective-dated
   * rule engine, as a SUGGESTED default for the hire form's on-cost field —
   * the user can change it, and it is never applied silently. `null` if the
   * rule engine has no rule set for the date (never extrapolated).
   */
  async suggestedHireOnCost(asOfDate: Date = new Date()): Promise<{ percent: string; source: string } | null> {
    try {
      const rules = await TaxRuleService.resolve("AU", asOfDate);
      return { percent: new Decimal(rules.sgRate).times(100).toFixed(2), source: `Superannuation Guarantee rate, ${rules.label} (super only — add any other on-costs yourself)` };
    } catch {
      return null;
    }
  },

  /** Trailing-12-month invoiced revenue per customer, largest first — feeds the LOSE_CUSTOMER form's default and picker. */
  async listCustomerRevenue(actor: Actor, asOfDate: Date = new Date()): Promise<Array<{ customerContactId: string; name: string; revenue: string }>> {
    assertPermission(actor, "scenario:read");
    assertPermission(actor, "customer_invoice:read");
    const asOf = startOfUtcDay(asOfDate);
    return withTenant(actor.organizationId, async (tx) => {
      const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 12, asOf.getUTCDate() + 1));
      const rows = await loadRevenueRows(tx, actor.organizationId, from, new Date(asOf.getTime() + DAY_MS - 1), "XXX");
      const byCustomer = new Map<string, Money>();
      for (const r of rows) byCustomer.set(r.customerId, (byCustomer.get(r.customerId) ?? Money.zero("XXX")).add(r.revenue));
      const ids = [...byCustomer.keys()];
      if (ids.length === 0) return [];
      const names = await tx.select({ id: contacts.id, name: contacts.displayName }).from(contacts).where(inArray(contacts.id, ids));
      const nameById = new Map(names.map((n) => [n.id, n.name]));
      return [...byCustomer.entries()]
        .map(([id, revenue]) => ({ customerContactId: id, name: nameById.get(id) ?? id, revenue: revenue.toString(), _r: revenue }))
        .sort((a, b) => b._r.compareTo(a._r))
        .map(({ _r, ...rest }) => rest);
    });
  },
};

// ---------------------------------------------------------------------------
// The shared run
// ---------------------------------------------------------------------------

async function runScenario(
  actor: Actor,
  meta: { scenarioId: string | null; name: string; spec: ScenarioParams },
  options: RunScenarioOptions,
): Promise<ScenarioRunResult> {
  const asOf = startOfUtcDay(options.asOfDate ?? new Date());
  const cashAsOf = new Date(asOf.getTime() + DAY_MS - 1);
  const months = projectionMonths(asOf);
  const { spec } = meta;

  // A BUDGET baseline reads an ACTIVE baseline budget (Phase 9 Slice 1), gated on budget:read like the budget pages.
  let resolvedBudgetId: string | null = null;
  const baselineSource = spec.params.baseline;
  if (baselineSource.source === "BUDGET") {
    assertPermission(actor, "budget:read");
    if (baselineSource.budgetId) {
      const b = await BudgetService.get(actor, baselineSource.budgetId);
      if (!b) throw new ScenarioBaselineUnavailableError("The selected budget no longer exists.");
      if (b.status !== "ACTIVE") throw new ScenarioBaselineUnavailableError(`Budget "${b.name}" is ${b.status}, not ACTIVE — activate it or pick another baseline.`);
      resolvedBudgetId = b.id;
    } else {
      const active = await BudgetService.findActiveBaseline(actor, months[0]!);
      if (!active) throw new ScenarioBaselineUnavailableError("No ACTIVE baseline budget covers the projection window — create/activate one or use trailing actuals as the baseline.");
      resolvedBudgetId = active.id;
    }
  }

  const cash = await loadCashPosition(actor, cashAsOf);
  const currency = cash.currency;
  const openingCash = Money.of(cash.total, currency);

  // `loadRevenueRows` reads customer invoices — only needed (and only permitted) for the invoice-derived scenarios.
  const needsInvoiceData = spec.type !== "HIRE_EMPLOYEE";
  if (needsInvoiceData) assertPermission(actor, "customer_invoice:read");

  const data = await withTenant(actor.organizationId, async (tx) => {
    const base = await loadBaselineMonths(tx, actor.organizationId, baselineSource, asOf, months, currency, resolvedBudgetId);

    let rows: RevenueRow[] = [];
    let totalRevenue12m = Money.zero(currency);
    let windowLabel = "";
    if (needsInvoiceData) {
      const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 12, asOf.getUTCDate() + 1));
      windowLabel = `${dateKey(from)} to ${dateKey(asOf)}`;
      rows = await loadRevenueRows(tx, actor.organizationId, from, cashAsOf, currency);
      const pnl = await sumPostedActivityByAccount(tx, actor.organizationId, { from, to: cashAsOf });
      totalRevenue12m = pnl.filter((r) => r.type === "REVENUE").reduce((s, r) => s.add(normalSignedBalance(r, currency)), Money.zero(currency));
    }

    let customer: { id: string; name: string; openReceivables: Money } | null = null;
    if (spec.type === "LOSE_CUSTOMER") {
      const byCustomer = new Map<string, Money>();
      for (const r of rows) byCustomer.set(r.customerId, (byCustomer.get(r.customerId) ?? Money.zero(currency)).add(r.revenue));
      let customerId = spec.params.customerContactId;
      if (!customerId) {
        const largest = [...byCustomer.entries()].sort((a, b) => b[1].compareTo(a[1]))[0];
        if (!largest) throw new ScenarioBaselineUnavailableError("No customer has any invoiced revenue in the trailing 12 months, so there is no 'largest customer' to lose. Pick a customer explicitly.");
        customerId = largest[0];
      }
      const [contact] = await tx
        .select({ id: contacts.id, name: contacts.displayName })
        .from(contacts)
        .where(and(eq(contacts.id, customerId), eq(contacts.organizationId, actor.organizationId)));
      if (!contact) throw new ScenarioBaselineUnavailableError("The selected customer does not exist in this organization.");

      const open = await tx
        .select({ id: invoices.id, total: invoices.total, currency: invoices.currency })
        .from(invoices)
        .where(
          and(
            eq(invoices.organizationId, actor.organizationId),
            eq(invoices.customerContactId, customerId),
            ne(invoices.status, "DRAFT"),
            ne(invoices.status, "VOID"),
            ne(invoices.status, "PAID"),
          ),
        )
        .orderBy(asc(invoices.dueDate));
      let openReceivables = Money.zero(currency);
      for (const inv of open) {
        const allocated = await loadAllocatedTotal(tx, actor.organizationId, inv.id);
        const outstanding = Money.of(inv.total, inv.currency).subtract(Money.of(allocated, inv.currency));
        if (outstanding.isPositive()) openReceivables = openReceivables.add(outstanding);
      }
      customer = { id: contact.id, name: contact.name, openReceivables };
    }

    return { base, rows, totalRevenue12m, windowLabel, customer };
  });

  const baselineMonths = data.base.months;
  const warnings = [...data.base.warnings];
  const derivedInputs: DerivedInput[] = [];
  const keyFigures: DerivedInput[] = [];
  const cases = {} as Record<CaseName, ScenarioCaseResult>;

  if (spec.type === "HIRE_EMPLOYEE") {
    const p = spec.params;
    const monthlyCost = hireMonthlyCost(p, currency);
    keyFigures.push(
      { label: "Fully loaded monthly cost", value: `${monthlyCost.toString()} ${currency}`, note: `salary ÷ 12 × (1 + ${p.onCostPercent}% on-costs)` },
      { label: "Monthly revenue needed to break even", value: `${monthlyCost.toString()} ${currency}`, note: "incremental revenue that exactly covers the fully loaded cost, before any cost of delivering it" },
    );
    for (const c of CASE_NAMES) {
      const assumptions: CaseAssumption[] = [
        { label: "Revenue realised vs. stated expectation", value: `${revenuePercentForCase(p, c)}%`, parameter: c === "BEST" ? "bestRevenuePercentOfExpected" : c === "WORST" ? "worstRevenuePercentOfExpected" : undefined },
        { label: "Stated incremental monthly revenue", value: `${p.incrementalMonthlyRevenue} ${currency}`, parameter: "incrementalMonthlyRevenue" },
        { label: "Revenue ramp", value: p.rampMonths === 0 ? "full from the start date" : `linear over ${p.rampMonths} month(s)`, parameter: "rampMonths" },
        { label: "On-cost", value: `${p.onCostPercent}% of salary`, parameter: "onCostPercent" },
      ];
      cases[c] = assembleCase(c, assumptions, baselineMonths, hireDeltas(p, c, months, currency), openingCash);
    }
  } else if (spec.type === "PRICE_CHANGE") {
    const p = spec.params;
    const scope = p.scope;
    const inScope = data.rows.filter((r) => {
      if (scope.kind === "ALL") return true;
      if (scope.kind === "CUSTOMERS") return scope.customerContactIds.includes(r.customerId);
      if (scope.kind === "PRODUCTS") return r.productId !== null && scope.productIds.includes(r.productId);
      return scope.accountIds.includes(r.accountId);
    });
    const scoped = sumRows(inScope, currency);
    const denominator = data.totalRevenue12m.compareTo(sumRows(data.rows, currency).revenue) >= 0 ? data.totalRevenue12m : sumRows(data.rows, currency).revenue;
    const share = clampedShare(scoped.revenue, denominator);
    if (!share.gt(0)) warnings.push("No invoiced revenue falls in this scenario's scope over the trailing 12 months, so the price change has nothing to apply to.");
    const derivedCost = costPercent(scoped.revenue, scoped.cost);
    const variableCost = p.variableCostPercentOverride ?? derivedCost;

    derivedInputs.push(
      { label: "In-scope revenue, trailing 12 months", value: `${scoped.revenue.toString()} ${currency}`, note: data.windowLabel },
      { label: "Share of total trailing-12-month revenue", value: `${round2(share.times(100))}%`, note: "applied to each baseline month's revenue" },
      {
        label: "Variable (avoidable) cost on volume changes",
        value: `${variableCost}%`,
        note: p.variableCostPercentOverride ? "your override" : `derived: cost of sales attributable to in-scope tracked-inventory sales ÷ in-scope revenue (${derivedCost}%) — 0 means none is attributable in the data`,
      },
    );
    for (const c of CASE_NAMES) {
      const assumptions: CaseAssumption[] = [
        { label: "Price change", value: `${p.priceChangePercent}%`, parameter: "priceChangePercent" },
        { label: "Volume change assumed", value: `${volumeForCase(p, c)}%`, parameter: `volumeChangePercent.${c.toLowerCase()}` },
        { label: "Effective", value: p.effectiveDate, parameter: "effectiveDate" },
      ];
      cases[c] = assembleCase(c, assumptions, baselineMonths, priceChangeDeltas(p, c, baselineMonths, share, variableCost, currency), openingCash);
    }
  } else {
    const p = spec.params;
    const customer = data.customer!;
    const customerRows = data.rows.filter((r) => r.customerId === customer.id);
    const mine = sumRows(customerRows, currency);
    const denominator = data.totalRevenue12m.compareTo(sumRows(data.rows, currency).revenue) >= 0 ? data.totalRevenue12m : sumRows(data.rows, currency).revenue;
    const share = clampedShare(mine.revenue, denominator);
    const derivedCost = costPercent(mine.revenue, mine.cost);
    const avoided = p.avoidedCostPercentOverride ?? derivedCost;
    if (!mine.revenue.isPositive()) warnings.push(`${customer.name} has no invoiced revenue in the trailing 12 months, so losing them changes nothing in this model.`);

    derivedInputs.push(
      { label: "Customer", value: customer.name, note: p.customerContactId ? "selected" : "defaulted to the largest customer by trailing-12-month invoiced revenue" },
      { label: "Trailing-12-month revenue from this customer", value: `${mine.revenue.toString()} ${currency}`, note: data.windowLabel },
      { label: "Share of total trailing-12-month revenue", value: `${round2(share.times(100))}%`, note: "applied to each baseline month's revenue" },
      {
        label: "Cost avoided when the revenue goes",
        value: `${avoided}%`,
        note: p.avoidedCostPercentOverride
          ? "your override"
          : mine.cost.isPositive()
            ? `derived: cost of sales attributable to this customer's tracked-inventory sales ÷ their revenue`
            : "no cost of sales is attributable to this customer in the data (no tracked-inventory sales), so this is a REVENUE-ONLY view: the margin effect equals the revenue effect unless you enter an avoided-cost % override",
      },
      { label: "Open receivables from this customer", value: `${customer.openReceivables.toString()} ${currency}`, note: "used by the worst case's collection delay" },
    );
    for (const c of CASE_NAMES) {
      const assumptions: CaseAssumption[] = [
        { label: "Lost from", value: p.effectiveDate, parameter: "effectiveDate" },
        c === "BEST"
          ? { label: "Lost revenue replaced by new business", value: `${p.bestReplacementPercent}% starting ${p.bestReplacementLagMonths} month(s) later`, parameter: "bestReplacementPercent" }
          : { label: "Lost revenue replaced", value: "0% (no replacement)" },
        c === "WORST"
          ? { label: "Open receivables collected late by", value: `${p.worstCollectionDelayMonths} month(s)`, parameter: "worstCollectionDelayMonths" }
          : { label: "Open receivables", value: "collected on time" },
      ];
      cases[c] = assembleCase(
        c,
        assumptions,
        baselineMonths,
        loseCustomerDeltas(p, c, baselineMonths, share, avoided, customer.openReceivables, currency),
        openingCash,
      );
    }
  }

  let forecastContext: ScenarioRunResult["forecastContext"] = null;
  if (options.includeForecastContext !== false && roleHasPermission(actor.role, "forecast:read")) {
    const forecast = await CashForecastService.generate(actor, { asOfDate: asOf, horizon: "90D", preloaded: { cashPosition: cash } });
    forecastContext = {
      horizon: "90D",
      knownOnlyLowPoint: forecast.knownOnly.lowPoint,
      withStatisticalLowPoint: forecast.withStatistical.lowPoint,
      knownOnlyEnd: forecast.knownOnly.endBalance,
      withStatisticalEnd: forecast.withStatistical.endBalance,
      warningMessage: forecast.warning.message,
      payrollOmitted: forecast.payrollOmitted,
    };
  }

  return {
    scenarioId: meta.scenarioId,
    name: meta.name,
    type: spec.type,
    asOf: dateKey(asOf),
    currency,
    parameters: spec.params,
    baseline: {
      source: baselineSource.source,
      label: data.base.label,
      openingCash: openingCash.toString(),
      months: baselineMonths.map((b) => ({ month: monthLabel(b.monthStart), revenue: b.revenue.toString(), expenses: b.expenses.toString() })),
      warnings,
    },
    derivedInputs,
    keyFigures,
    cases,
    forecastContext,
    caveats: SCENARIO_CAVEATS,
  };
}

