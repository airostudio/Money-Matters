import { Money } from "@/domain/money/money";
import type { AccountType } from "@/domain/accounts/account-service";
import { CURRENT_YEAR_EARNINGS_LABEL, RETAINED_EARNINGS_PRIOR_LABEL } from "@/domain/reporting/financial-statements";
import { createAccountResolver, type AccountResolver } from "./account-mapping";
import {
  BALANCE_SHEET_CATEGORIES,
  PROFIT_AND_LOSS_CATEGORIES,
  computeIntercompanyEliminations,
  type AccountReduction,
} from "./eliminations";
import type {
  AdjustmentDef,
  AppliedAdjustment,
  ColumnTotals,
  ConsolidatedBalanceSheet,
  ConsolidatedCash,
  ConsolidatedLine,
  ConsolidatedProfitAndLoss,
  ConsolidatedSection,
  ConsolidationConfig,
  EntityColumn,
  EntityStatement,
  GroupAccountDef,
  LineSource,
  MappingSource,
} from "./types";

/**
 * The pure consolidation engine: takes the already-authorised, already-computed
 * per-entity statements (ReportingService output, normal-balance signed) plus
 * the group's own configuration, and returns the consolidated statement with
 * the per-entity columns, the combined column, the eliminations/adjustments
 * columns and the consolidated column. No database access, no permission
 * checks (those happened, per entity, before anything reached this module) —
 * which is also why it is exhaustively unit-testable against hand-computed
 * numbers. Every figure is a src/domain/money Decimal.
 */

/** The consolidation equation is evaluated per column so a broken column is visible, not hidden in a total. */
const DEBIT_NORMAL = new Set<AccountType>(["ASSET", "EXPENSE"]);

/** Normal-balance-signed effect of a debit/credit pair on an account of `type`. */
export function normalSignedDelta(type: AccountType, debit: Money, credit: Money): Money {
  return DEBIT_NORMAL.has(type) ? debit.subtract(credit) : credit.subtract(debit);
}

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: "assets",
  LIABILITY: "liabilities",
  EQUITY: "equity",
  REVENUE: "revenue",
  EXPENSE: "expenses",
};

interface Accum {
  key: string;
  kind: ConsolidatedLine["kind"];
  type: AccountType;
  code: string | null;
  name: string;
  byEntity: Map<string, Money>;
  eliminations: Money;
  adjustments: Money;
  sources: LineSource[];
}

function entityColumns(statements: EntityStatement[]): EntityColumn[] {
  return statements
    .map((s) => ({ organizationId: s.entity.organizationId, name: s.entity.name, slug: s.entity.slug, role: s.entity.role }))
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "PARENT" ? -1 : 1));
}

class Ledger {
  readonly accums = new Map<string, Accum>();
  constructor(
    private readonly currency: string,
    private readonly groupAccounts: Map<string, GroupAccountDef>,
  ) {}

  private ensure(key: string, init: () => Omit<Accum, "byEntity" | "eliminations" | "adjustments" | "sources" | "key">): Accum {
    let a = this.accums.get(key);
    if (!a) {
      a = {
        key,
        ...init(),
        byEntity: new Map(),
        eliminations: Money.zero(this.currency),
        adjustments: Money.zero(this.currency),
        sources: [],
      };
      this.accums.set(key, a);
    }
    return a;
  }

  groupAccountAccum(id: string): Accum {
    const g = this.groupAccounts.get(id);
    if (!g) throw new Error(`Group account ${id} is not part of this group.`);
    return this.ensure(`ga:${id}`, () => ({ kind: "GROUP_ACCOUNT", type: g.type, code: g.code, name: g.name }));
  }

  unmappedAccum(type: AccountType): Accum {
    return this.ensure(`unmapped:${type}`, () => ({ kind: "UNMAPPED", type, code: null, name: `Unmapped ${TYPE_LABEL[type]}` }));
  }

  computedAccum(which: "RE_PRIOR" | "CURRENT_YEAR"): Accum {
    return this.ensure(`computed:${which}`, () => ({
      kind: "COMPUTED",
      type: "EQUITY",
      code: null,
      name: which === "RE_PRIOR" ? RETAINED_EARNINGS_PRIOR_LABEL : CURRENT_YEAR_EARNINGS_LABEL,
    }));
  }

  /** Where an entity account lands: mapped group line or the unmapped bucket. */
  accumFor(resolve: AccountResolver, organizationId: string, account: { accountId: string; code: string; type: AccountType }) {
    const r = resolve(organizationId, account);
    if (r.kind === "MAPPED") return { accum: this.groupAccountAccum(r.groupAccount.id), mapping: r.via as MappingSource };
    return { accum: this.unmappedAccum(account.type), mapping: "UNMAPPED" as MappingSource };
  }

  place(statements: EntityStatement[], resolve: AccountResolver, types: Set<AccountType>) {
    for (const st of statements) {
      const org = st.entity.organizationId;
      for (const line of st.lines) {
        if (!types.has(line.type)) continue;
        const amount = Money.of(line.amount, this.currency);
        if (amount.isZero()) continue;

        let accum: Accum;
        let mapping: MappingSource;
        if (line.computed) {
          accum = this.computedAccum(line.computed);
          mapping = "COMPUTED";
        } else {
          ({ accum, mapping } = this.accumFor(resolve, org, { accountId: line.accountId!, code: line.code ?? "", type: line.type }));
        }
        accum.byEntity.set(org, (accum.byEntity.get(org) ?? Money.zero(this.currency)).add(amount));
        accum.sources.push({
          organizationId: org,
          organizationSlug: st.entity.slug,
          accountId: line.accountId,
          code: line.code,
          name: line.name,
          amount: amount.toString(),
          mapping,
        });
      }
    }
  }

  applyReductions(reductions: AccountReduction[], resolve: AccountResolver, types: Set<AccountType>) {
    for (const r of reductions) {
      if (!types.has(r.type)) continue;
      const { accum } = this.accumFor(resolve, r.organizationId, { accountId: r.accountId, code: r.code, type: r.type });
      accum.eliminations = accum.eliminations.subtract(r.amount);
    }
  }

  toLines(entityIds: string[], typeFilter: AccountType): ConsolidatedLine[] {
    const zero = Money.zero(this.currency);
    const out: ConsolidatedLine[] = [];
    for (const a of this.accums.values()) {
      if (a.type !== typeFilter) continue;
      const entityAmounts = entityIds.map((id) => a.byEntity.get(id) ?? zero);
      const combined = entityAmounts.reduce((s, m) => s.add(m), zero);
      if (combined.isZero() && a.eliminations.isZero() && a.adjustments.isZero() && a.sources.length === 0) continue;
      const consolidated = combined.add(a.eliminations).add(a.adjustments);
      const byEntity: Record<string, string> = {};
      entityIds.forEach((id, i) => {
        byEntity[id] = entityAmounts[i]!.toString();
      });
      out.push({
        key: a.key,
        kind: a.kind,
        type: a.type,
        code: a.code,
        name: a.name,
        byEntity,
        combined: combined.toString(),
        eliminations: a.eliminations.toString(),
        adjustments: a.adjustments.toString(),
        consolidated: consolidated.toString(),
        sources: a.sources,
      });
    }
    const rank = (l: ConsolidatedLine) => (l.kind === "GROUP_ACCOUNT" ? 0 : l.kind === "COMPUTED" ? 1 : 2);
    out.sort((x, y) => rank(x) - rank(y) || (x.code ?? "").localeCompare(y.code ?? "") || x.name.localeCompare(y.name));
    return out;
  }
}

function sumLines(lines: ConsolidatedLine[], entityIds: string[], currency: string): ColumnTotals {
  const zero = Money.zero(currency);
  const byEntity = new Map(entityIds.map((id) => [id, zero]));
  let combined = zero;
  let eliminations = zero;
  let adjustments = zero;
  let consolidated = zero;
  for (const l of lines) {
    for (const id of entityIds) byEntity.set(id, byEntity.get(id)!.add(Money.of(l.byEntity[id] ?? "0", currency)));
    combined = combined.add(Money.of(l.combined, currency));
    eliminations = eliminations.add(Money.of(l.eliminations, currency));
    adjustments = adjustments.add(Money.of(l.adjustments, currency));
    consolidated = consolidated.add(Money.of(l.consolidated, currency));
  }
  return {
    byEntity: Object.fromEntries([...byEntity].map(([k, v]) => [k, v.toString()])),
    combined: combined.toString(),
    eliminations: eliminations.toString(),
    adjustments: adjustments.toString(),
    consolidated: consolidated.toString(),
  };
}

function combineTotals(
  a: ColumnTotals,
  b: ColumnTotals,
  op: "add" | "subtract",
  entityIds: string[],
  currency: string,
): ColumnTotals {
  const f = (x: string, y: string) =>
    (op === "add" ? Money.of(x, currency).add(Money.of(y, currency)) : Money.of(x, currency).subtract(Money.of(y, currency))).toString();
  return {
    byEntity: Object.fromEntries(entityIds.map((id) => [id, f(a.byEntity[id] ?? "0", b.byEntity[id] ?? "0")])),
    combined: f(a.combined, b.combined),
    eliminations: f(a.eliminations, b.eliminations),
    adjustments: f(a.adjustments, b.adjustments),
    consolidated: f(a.consolidated, b.consolidated),
  };
}

function totalsAreZero(t: ColumnTotals): boolean {
  return (
    Object.values(t.byEntity).every((v) => Money.of(v, "X").isZero()) &&
    Money.of(t.combined, "X").isZero() &&
    Money.of(t.eliminations, "X").isZero() &&
    Money.of(t.adjustments, "X").isZero() &&
    Money.of(t.consolidated, "X").isZero()
  );
}

function appliedAdjustment(adj: AdjustmentDef, groupAccounts: Map<string, GroupAccountDef>): AppliedAdjustment {
  return {
    id: adj.id,
    kind: adj.kind,
    effectiveDate: adj.effectiveDate.toISOString(),
    description: adj.description,
    reversesAdjustmentId: adj.reversesAdjustmentId,
    lines: adj.lines.map((l) => {
      const g = groupAccounts.get(l.groupAccountId);
      return {
        groupAccountId: l.groupAccountId,
        code: g?.code ?? "?",
        name: g?.name ?? "Unknown group account",
        type: (g?.type ?? "ASSET") as AccountType,
        debit: Money.of(l.debit, "X").toString(),
        credit: Money.of(l.credit, "X").toString(),
      };
    }),
  };
}

function setOf(...types: AccountType[]) {
  return new Set<AccountType>(types);
}

export function consolidationCurrency(statements: EntityStatement[]): string {
  return statements[0]?.entity.currency ?? "AUD";
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------

export function buildConsolidatedProfitAndLoss(input: {
  statements: EntityStatement[];
  config: ConsolidationConfig;
  from: Date;
  to: Date;
  currency: string;
}): ConsolidatedProfitAndLoss {
  const { statements, config, currency } = input;
  const columns = entityColumns(statements);
  const entityIds = columns.map((c) => c.organizationId);
  const groupAccounts = new Map(config.groupAccounts.map((g) => [g.id, g]));
  const resolve = createAccountResolver(config.groupAccounts, config.mappings);
  const types = setOf("REVENUE", "EXPENSE");

  const ledger = new Ledger(currency, groupAccounts);
  ledger.place(statements, resolve, types);

  const elim = computeIntercompanyEliminations({
    categories: PROFIT_AND_LOSS_CATEGORIES,
    statements,
    designations: config.intercompany,
    currency,
  });
  ledger.applyReductions(elim.reductions, resolve, types);

  const applied: AppliedAdjustment[] = [];
  for (const adj of config.adjustments) {
    if (adj.effectiveDate < input.from || adj.effectiveDate > input.to) continue;
    let touched = false;
    for (const l of adj.lines) {
      const g = groupAccounts.get(l.groupAccountId);
      if (!g || !types.has(g.type)) continue;
      touched = true;
      const accum = ledger.groupAccountAccum(g.id);
      accum.adjustments = accum.adjustments.add(
        normalSignedDelta(g.type, Money.of(l.debit, currency), Money.of(l.credit, currency)),
      );
    }
    if (touched) applied.push(appliedAdjustment(adj, groupAccounts));
  }

  const revenueLines = ledger.toLines(entityIds, "REVENUE");
  const expenseLines = ledger.toLines(entityIds, "EXPENSE");
  const revenue: ConsolidatedSection = { lines: revenueLines, totals: sumLines(revenueLines, entityIds, currency) };
  const expenses: ConsolidatedSection = { lines: expenseLines, totals: sumLines(expenseLines, entityIds, currency) };

  return {
    currency,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    entities: columns,
    revenue,
    expenses,
    netProfit: combineTotals(revenue.totals, expenses.totals, "subtract", entityIds, currency),
    eliminationEntries: elim.entries,
    adjustments: applied,
    reconciliation: elim.reconciliation,
    unmapped: { count: [...revenueLines, ...expenseLines].filter((l) => l.kind === "UNMAPPED").length },
  };
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------

export function buildConsolidatedBalanceSheet(input: {
  statements: EntityStatement[];
  config: ConsolidationConfig;
  asOf: Date;
  currency: string;
}): ConsolidatedBalanceSheet {
  const { statements, config, currency } = input;
  const columns = entityColumns(statements);
  const entityIds = columns.map((c) => c.organizationId);
  const groupAccounts = new Map(config.groupAccounts.map((g) => [g.id, g]));
  const resolve = createAccountResolver(config.groupAccounts, config.mappings);
  const types = setOf("ASSET", "LIABILITY", "EQUITY");

  const ledger = new Ledger(currency, groupAccounts);
  // The two computed earnings lines always exist, as on a single-entity Balance Sheet.
  ledger.computedAccum("RE_PRIOR");
  ledger.computedAccum("CURRENT_YEAR");
  ledger.place(statements, resolve, types);

  const elim = computeIntercompanyEliminations({
    categories: BALANCE_SHEET_CATEGORIES,
    statements,
    designations: config.intercompany,
    currency,
  });
  ledger.applyReductions(elim.reductions, resolve, types);

  // Same fiscal-year convention as the single-entity Balance Sheet (calendar year).
  const fiscalYearStart = new Date(Date.UTC(input.asOf.getUTCFullYear(), 0, 1));
  const applied: AppliedAdjustment[] = [];
  for (const adj of config.adjustments) {
    if (adj.effectiveDate > input.asOf) continue;
    applied.push(appliedAdjustment(adj, groupAccounts));
    for (const l of adj.lines) {
      const g = groupAccounts.get(l.groupAccountId);
      if (!g) continue;
      const debit = Money.of(l.debit, currency);
      const credit = Money.of(l.credit, currency);
      if (types.has(g.type)) {
        const accum = ledger.groupAccountAccum(g.id);
        accum.adjustments = accum.adjustments.add(normalSignedDelta(g.type, debit, credit));
      } else {
        // A P&L-account adjustment changes earnings, which the Balance Sheet
        // carries as the two computed equity lines (profit = credit - debit).
        const accum = ledger.computedAccum(adj.effectiveDate < fiscalYearStart ? "RE_PRIOR" : "CURRENT_YEAR");
        accum.adjustments = accum.adjustments.add(credit.subtract(debit));
      }
    }
  }

  const assetLines = ledger.toLines(entityIds, "ASSET");
  const liabilityLines = ledger.toLines(entityIds, "LIABILITY");
  const equityLines = ledger.toLines(entityIds, "EQUITY");
  const assets: ConsolidatedSection = { lines: assetLines, totals: sumLines(assetLines, entityIds, currency) };
  const liabilities: ConsolidatedSection = { lines: liabilityLines, totals: sumLines(liabilityLines, entityIds, currency) };
  const equity: ConsolidatedSection = { lines: equityLines, totals: sumLines(equityLines, entityIds, currency) };

  const totalLiabilitiesAndEquity = combineTotals(liabilities.totals, equity.totals, "add", entityIds, currency);
  const difference = combineTotals(assets.totals, totalLiabilitiesAndEquity, "subtract", entityIds, currency);

  return {
    currency,
    asOfDate: input.asOf.toISOString(),
    entities: columns,
    assets,
    liabilities,
    equity,
    totalLiabilitiesAndEquity,
    difference,
    isBalanced: totalsAreZero(difference),
    isConsolidatedBalanced: Money.of(difference.consolidated, currency).isZero(),
    eliminationEntries: elim.entries,
    adjustments: applied,
    reconciliation: elim.reconciliation,
    unmapped: { count: [...assetLines, ...liabilityLines, ...equityLines].filter((l) => l.kind === "UNMAPPED").length },
  };
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

export function buildConsolidatedCash(input: {
  entities: Array<{
    organizationId: string;
    name: string;
    slug: string;
    total: string;
    accounts: Array<{ bankAccountId: string; name: string; institutionName: string | null; balance: string }>;
  }>;
  asOf: Date;
  currency: string;
}): ConsolidatedCash {
  const total = input.entities.reduce((s, e) => s.add(Money.of(e.total, input.currency)), Money.zero(input.currency));
  return {
    currency: input.currency,
    asOfDate: input.asOf.toISOString(),
    entities: [...input.entities].sort((a, b) => a.name.localeCompare(b.name)),
    total: total.toString(),
  };
}
