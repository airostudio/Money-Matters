import "server-only";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { ReportingService, type PeriodRange } from "@/domain/reporting/reporting-service";
import { loadCashPosition, type CashPosition } from "@/domain/reporting/cash-position";
import {
  CURRENT_YEAR_EARNINGS_LABEL,
  type BalanceSheetReport,
  type ProfitAndLossReport,
} from "@/domain/reporting/financial-statements";
import {
  buildConsolidatedBalanceSheet,
  buildConsolidatedCash,
  buildConsolidatedProfitAndLoss,
} from "./consolidate";
import { entityActorFor, loadEntityAccessMap, type EntityAccess, type GroupActor } from "./entity-access";
import { GroupTooLargeError, MixedCurrencyError } from "./errors";
import { loadGroupSnapshot, type GroupMemberRow, type GroupSnapshot } from "./group-snapshot";
import {
  MAX_ENTITIES_PER_GROUP,
  type ConsolidatedBalanceSheet,
  type ConsolidatedCash,
  type ConsolidatedProfitAndLoss,
  type ConsolidatedReport,
  type EntityLine,
  type EntityStatement,
  type ExclusionNotice,
} from "./types";

/**
 * The per-entity reads a consolidated report is built from. Production uses
 * the real `ReportingService` / cash-position functions; a test can inject
 * instrumented ones to prove the discipline below (strictly sequential, one
 * entity at a time, only entities the user may read). They are the SAME
 * functions the single-entity report pages call — consolidation re-derives no
 * ledger logic.
 */
export interface ConsolidationDeps {
  getProfitAndLoss(actor: Actor, range: PeriodRange): Promise<ProfitAndLossReport>;
  getBalanceSheet(actor: Actor, asOf: Date): Promise<BalanceSheetReport>;
  loadCashPosition(actor: Actor, asOf: Date): Promise<CashPosition>;
}

export const defaultConsolidationDeps: ConsolidationDeps = {
  getProfitAndLoss: (actor, range) => ReportingService.getProfitAndLoss(actor, range),
  getBalanceSheet: (actor, asOf) => ReportingService.getBalanceSheet(actor, asOf),
  loadCashPosition: (actor, asOf) => loadCashPosition(actor, asOf),
};

interface Fetched<T> {
  member: GroupMemberRow;
  access: EntityAccess;
  data: T;
}

interface Collected<T> {
  fetched: Array<Fetched<T>>;
  exclusions: ExclusionNotice;
  deselectedCount: number;
}

function exclusionNotice(count: number, knownNames: string[]): ExclusionNotice {
  return {
    count,
    notice: count === 0 ? null : `${count} ${count === 1 ? "entity" : "entities"} excluded — no access`,
    knownNames,
  };
}

/**
 * THE consolidation access loop — every consolidated figure comes through here.
 *
 *  1. Strictly SEQUENTIAL: a plain `for` loop that awaits each entity before
 *     starting the next, so at most one pooled connection (one `withTenant`
 *     transaction) is ever checked out by a consolidation at a time. Never
 *     `Promise.all` (a structural test asserts none appears in this module) —
 *     the Supabase session pooler caps the whole project at a handful of
 *     clients (src/db/client.ts).
 *  2. Per-entity authorisation with the user's REAL role in THAT entity: an
 *     entity the user has no active membership in is never touched (no
 *     transaction is opened for it); for the rest, the fetch runs under an
 *     `Actor` built from their membership there and the report service itself
 *     enforces `financial_report:read` — a `PermissionDeniedError` excludes the
 *     entity. A platform admin is not special here.
 *  3. Bounded: at most MAX_ENTITIES_PER_GROUP entities.
 *
 * Excluded entities contribute nothing but a count (and, only where the user is
 * still a member and so already knows the name, a name).
 */
async function collect<T>(
  actor: GroupActor,
  snapshot: GroupSnapshot,
  access: Map<string, EntityAccess>,
  fetchOne: (entityActor: Actor, entry: EntityAccess) => Promise<T>,
): Promise<Collected<T>> {
  const included = snapshot.members.filter((m) => m.isIncluded);
  if (included.length > MAX_ENTITIES_PER_GROUP) throw new GroupTooLargeError();

  const fetched: Array<Fetched<T>> = [];
  let excluded = 0;
  const knownNames: string[] = [];

  for (const member of included) {
    const entry = access.get(member.organizationId);
    if (!entry) {
      excluded += 1;
      continue;
    }
    const { actor: entityActor } = entityActorFor(actor, member.organizationId, access);
    try {
      const data = await fetchOne(entityActor, entry);
      fetched.push({ member, access: entry, data });
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        excluded += 1;
        knownNames.push(entry.organization.name);
        continue;
      }
      throw error;
    }
  }

  return {
    fetched,
    exclusions: exclusionNotice(excluded, knownNames),
    deselectedCount: snapshot.members.length - included.length,
  };
}

function assertSingleCurrency(fetched: Array<{ access: EntityAccess }>): string {
  const currencies = [...new Set(fetched.map((f) => f.access.organization.baseCurrency))];
  if (currencies.length > 1) throw new MixedCurrencyError(currencies);
  return currencies[0] ?? "AUD";
}

function entityRef(f: Fetched<unknown>) {
  return {
    organizationId: f.member.organizationId,
    name: f.access.organization.name,
    slug: f.access.organization.slug,
    currency: f.access.organization.baseCurrency,
    role: f.member.role,
  };
}

function profitAndLossLines(report: ProfitAndLossReport): EntityLine[] {
  return [
    ...report.revenue.map((l): EntityLine => ({ accountId: l.accountId, code: l.code, name: l.name, type: "REVENUE", amount: l.amount })),
    ...report.expenses.map((l): EntityLine => ({ accountId: l.accountId, code: l.code, name: l.name, type: "EXPENSE", amount: l.amount })),
  ];
}

function balanceSheetLines(report: BalanceSheetReport): EntityLine[] {
  const out: EntityLine[] = [];
  for (const l of report.assets) out.push({ accountId: l.accountId, code: l.code, name: l.name, type: "ASSET", amount: l.amount });
  for (const l of report.liabilities) out.push({ accountId: l.accountId, code: l.code, name: l.name, type: "LIABILITY", amount: l.amount });
  for (const l of report.equity) {
    out.push({
      accountId: l.accountId,
      code: l.code,
      name: l.name,
      type: "EQUITY",
      amount: l.amount,
      computed: l.isComputed ? (l.name === CURRENT_YEAR_EARNINGS_LABEL ? "CURRENT_YEAR" : "RE_PRIOR") : undefined,
    });
  }
  return out;
}

/**
 * Consolidated reporting (master spec section 30), computed live and never
 * stored: the per-entity statements come from `ReportingService` one entity at
 * a time (see `collect`), and the pure engine in `consolidate.ts` aggregates the
 * already-authorised results in memory. No new database access path exists
 * here — no connection of its own, no cross-tenant query, no widened
 * row-level-security scope (docs/security.md section 12).
 */
export const ConsolidationService = {
  async profitAndLoss(
    actor: GroupActor,
    groupId: string,
    range: PeriodRange,
    deps: ConsolidationDeps = defaultConsolidationDeps,
  ): Promise<ConsolidatedReport<ConsolidatedProfitAndLoss>> {
    const snapshot = await loadGroupSnapshot(actor.userId, groupId);
    const access = await loadEntityAccessMap(actor.userId);
    const collected = await collect(actor, snapshot, access, (entityActor) => deps.getProfitAndLoss(entityActor, range));
    const currency = assertSingleCurrency(collected.fetched);

    const statements: EntityStatement[] = collected.fetched.map((f) => ({
      entity: entityRef(f),
      lines: profitAndLossLines(f.data),
    }));
    const report = buildConsolidatedProfitAndLoss({ statements, config: snapshot.config, from: range.from, to: range.to, currency });
    return { ...report, group: { id: snapshot.group.id, name: snapshot.group.name }, exclusions: collected.exclusions, deselectedCount: collected.deselectedCount };
  },

  async balanceSheet(
    actor: GroupActor,
    groupId: string,
    asOf: Date,
    deps: ConsolidationDeps = defaultConsolidationDeps,
  ): Promise<ConsolidatedReport<ConsolidatedBalanceSheet>> {
    const snapshot = await loadGroupSnapshot(actor.userId, groupId);
    const access = await loadEntityAccessMap(actor.userId);
    const collected = await collect(actor, snapshot, access, (entityActor) => deps.getBalanceSheet(entityActor, asOf));
    const currency = assertSingleCurrency(collected.fetched);

    const statements: EntityStatement[] = collected.fetched.map((f) => ({
      entity: entityRef(f),
      lines: balanceSheetLines(f.data),
    }));
    const report = buildConsolidatedBalanceSheet({ statements, config: snapshot.config, asOf, currency });
    return { ...report, group: { id: snapshot.group.id, name: snapshot.group.name }, exclusions: collected.exclusions, deselectedCount: collected.deselectedCount };
  },

  /**
   * Consolidated cash position: each entity's bank-account balances (the GL
   * balances of its linked accounts — the same `loadCashPosition` the Daily
   * Brief and cash forecast use) and their sum. Needs `bank_account:read` and
   * `journal:read` in each entity; an entity lacking either is excluded.
   * Cash is never eliminated (intercompany balances are not bank balances).
   */
  async cash(
    actor: GroupActor,
    groupId: string,
    asOf: Date,
    deps: ConsolidationDeps = defaultConsolidationDeps,
  ): Promise<ConsolidatedReport<ConsolidatedCash>> {
    const snapshot = await loadGroupSnapshot(actor.userId, groupId);
    const access = await loadEntityAccessMap(actor.userId);
    const collected = await collect(actor, snapshot, access, (entityActor) => deps.loadCashPosition(entityActor, asOf));
    const currency = assertSingleCurrency(collected.fetched);

    const cash = buildConsolidatedCash({
      entities: collected.fetched.map((f) => ({
        organizationId: f.member.organizationId,
        name: f.access.organization.name,
        slug: f.access.organization.slug,
        total: f.data.total,
        accounts: f.data.accounts,
      })),
      asOf,
      currency,
    });
    return { ...cash, group: { id: snapshot.group.id, name: snapshot.group.name }, exclusions: collected.exclusions, deselectedCount: collected.deselectedCount };
  },
};
