import { and, asc, eq, inArray, isNull, lte, gte } from "drizzle-orm";
import { accounts, budgetLines, budgets, dimensionValues } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { Money } from "@/domain/money/money";
import {
  BudgetNotEditableError,
  BudgetNotFoundError,
  InvalidBudgetError,
  OverlappingActiveBaselineError,
} from "./errors";
import { partitionLinesForRollingForecast, type RollingForecastSourceLine } from "./rolling-forecast";
import type { CreateBudgetInput, CreateRollingForecastInput, SetAccountLinesInput } from "./types";

export async function loadBudgetOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, id), eq(budgets.organizationId, organizationId)));
  if (!row) throw new BudgetNotFoundError(id);
  return row;
}

function assertEditable(budget: { name: string; status: string }) {
  if (budget.status !== "DRAFT") {
    throw new BudgetNotEditableError(budget.name, budget.status);
  }
}

async function loadAccountOrThrow(tx: TenantDb, organizationId: string, accountId: string) {
  const [account] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new InvalidBudgetError(`Account ${accountId} does not exist in this organization.`);
  return account;
}

async function loadDimensionValueOrThrow(tx: TenantDb, organizationId: string, dimensionValueId: string) {
  const [row] = await tx
    .select()
    .from(dimensionValues)
    .where(and(eq(dimensionValues.id, dimensionValueId), eq(dimensionValues.organizationId, organizationId)));
  if (!row) throw new InvalidBudgetError(`Dimension value ${dimensionValueId} does not exist in this organization.`);
  return row;
}

function monthBounds(month: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { periodStart, periodEnd };
}

/**
 * Budgets/forecasts (master spec §36). A `Budget` row is pure planning
 * data — see `budgets`'s doc comment in src/db/schema.ts for why it never
 * touches the ledger and why only a BASELINE's overlap is structurally
 * blocked. Lines are only editable while the budget is DRAFT
 * (`assertEditable`): the lifecycle is build-as-DRAFT → `activate()` →
 * (optionally) `archive()`, the same "finish editing, then commit" shape
 * `RecurringBillService`'s template/`FixedAssetService`'s registration
 * already use elsewhere in this codebase, chosen so an ACTIVE budget a
 * Budget vs. Actual report or the Management Pack is already reading from
 * can never change under a reader without a new, deliberate revision.
 */
export const BudgetService = {
  async list(actor: Actor, opts: { status?: string; type?: string } = {}) {
    assertPermission(actor, "budget:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(budgets.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(budgets.status, opts.status as "DRAFT"));
      if (opts.type) conditions.push(eq(budgets.type, opts.type as "BASELINE"));
      return tx
        .select()
        .from(budgets)
        .where(and(...conditions))
        .orderBy(asc(budgets.periodStart), asc(budgets.name));
    });
  },

  async get(actor: Actor, id: string) {
    assertPermission(actor, "budget:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.id, id), eq(budgets.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },

  /**
   * The org's current ACTIVE BASELINE budget whose period overlaps `date`,
   * if any — what `ManagementPackService`/the Budget vs. Actual report page
   * default to. Returns `null` (never throws) when none exists, so a
   * caller can cleanly omit the section rather than erroring.
   */
  async findActiveBaseline(actor: Actor, date: Date) {
    assertPermission(actor, "budget:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.organizationId, actor.organizationId),
            eq(budgets.type, "BASELINE"),
            eq(budgets.status, "ACTIVE"),
            lte(budgets.periodStart, date),
            gte(budgets.periodEnd, date),
          ),
        )
        .orderBy(asc(budgets.periodStart));
      return row ?? null;
    });
  },

  /** Every line for `budgetId`, joined with the account/dimension-value labels the UI needs — read-only, no aggregation. */
  async getLines(actor: Actor, budgetId: string) {
    assertPermission(actor, "budget:read");
    return withTenant(actor.organizationId, async (tx) => {
      await loadBudgetOr404(tx, actor.organizationId, budgetId);
      const rows = await tx
        .select({
          line: budgetLines,
          accountCode: accounts.code,
          accountName: accounts.name,
          dimensionValueLabel: dimensionValues.label,
        })
        .from(budgetLines)
        .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
        .leftJoin(dimensionValues, eq(dimensionValues.id, budgetLines.dimensionValueId))
        .where(and(eq(budgetLines.organizationId, actor.organizationId), eq(budgetLines.budgetId, budgetId)))
        .orderBy(asc(accounts.code), asc(budgetLines.periodStart));
      return rows.map((r) => ({
        id: r.line.id,
        accountId: r.line.accountId,
        accountCode: r.accountCode,
        accountName: r.accountName,
        dimensionValueId: r.line.dimensionValueId,
        dimensionValueLabel: r.dimensionValueLabel,
        periodStart: r.line.periodStart,
        periodEnd: r.line.periodEnd,
        amount: r.line.amount,
      }));
    });
  },

  async create(actor: Actor, input: CreateBudgetInput) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (!input.name.trim()) throw new InvalidBudgetError("A name is required.");
      if (input.periodEnd.getTime() < input.periodStart.getTime()) {
        throw new InvalidBudgetError("periodEnd must be on or after periodStart.");
      }

      const [created] = await tx
        .insert(budgets)
        .values({
          organizationId: actor.organizationId,
          name: input.name.trim(),
          type: input.type ?? "BASELINE",
          status: "DRAFT",
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          notes: input.notes ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create budget.");

      await AuditService.record(tx, actor, {
        action: "budget.created",
        entityType: "Budget",
        entityId: created.id,
        after: { name: created.name, type: created.type, periodStart: input.periodStart, periodEnd: input.periodEnd },
      });

      return created;
    });
  },

  /**
   * Bulk-entry upsert: one account's (optionally dimension-scoped) full set
   * of monthly figures in a single call — master spec §36's brief asks for
   * "a budget with even a modest chart of accounts × 12 months" to be
   * entered without one API call per cell. Replaces exactly the submitted
   * months for this (account, dimension value) pair — delete-then-insert
   * inside the same transaction, so resubmitting is idempotent and partial
   * (e.g. just Q1) without disturbing any other month already saved for
   * this account.
   */
  async setAccountLines(actor: Actor, budgetId: string, input: SetAccountLinesInput) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const budget = await loadBudgetOr404(tx, actor.organizationId, budgetId);
      assertEditable(budget);
      if (input.months.length === 0) throw new InvalidBudgetError("At least one month is required.");

      await loadAccountOrThrow(tx, actor.organizationId, input.accountId);
      if (input.dimensionValueId) await loadDimensionValueOrThrow(tx, actor.organizationId, input.dimensionValueId);

      const rows = input.months.map((m) => {
        const { periodStart, periodEnd } = monthBounds(m.month);
        if (periodStart.getTime() < budget.periodStart.getTime() || periodEnd.getTime() > budget.periodEnd.getTime()) {
          throw new InvalidBudgetError(
            `Month ${periodStart.toISOString().slice(0, 7)} falls outside this budget's period ` +
              `(${budget.periodStart.toISOString().slice(0, 10)} – ${budget.periodEnd.toISOString().slice(0, 10)}).`,
          );
        }
        return { periodStart, periodEnd, amount: Money.of(m.amount, "X").toString() };
      });

      const dimensionCondition = input.dimensionValueId
        ? eq(budgetLines.dimensionValueId, input.dimensionValueId)
        : isNull(budgetLines.dimensionValueId);

      await tx
        .delete(budgetLines)
        .where(
          and(
            eq(budgetLines.organizationId, actor.organizationId),
            eq(budgetLines.budgetId, budgetId),
            eq(budgetLines.accountId, input.accountId),
            dimensionCondition,
            inArray(
              budgetLines.periodStart,
              rows.map((r) => r.periodStart),
            ),
          ),
        );

      const inserted = await tx
        .insert(budgetLines)
        .values(
          rows.map((r) => ({
            organizationId: actor.organizationId,
            budgetId,
            accountId: input.accountId,
            dimensionValueId: input.dimensionValueId ?? null,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            amount: r.amount,
            createdById: actor.userId,
            updatedById: actor.userId,
          })),
        )
        .returning();

      await AuditService.record(tx, actor, {
        action: "budget.lines_set",
        entityType: "Budget",
        entityId: budgetId,
        after: {
          accountId: input.accountId,
          dimensionValueId: input.dimensionValueId ?? null,
          months: rows.map((r) => ({ periodStart: r.periodStart.toISOString().slice(0, 10), amount: r.amount })),
        },
      });

      return inserted;
    });
  },

  async removeLine(actor: Actor, budgetId: string, lineId: string) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const budget = await loadBudgetOr404(tx, actor.organizationId, budgetId);
      assertEditable(budget);

      const [deleted] = await tx
        .delete(budgetLines)
        .where(
          and(
            eq(budgetLines.id, lineId),
            eq(budgetLines.organizationId, actor.organizationId),
            eq(budgetLines.budgetId, budgetId),
          ),
        )
        .returning();
      if (!deleted) throw new InvalidBudgetError(`Budget line ${lineId} was not found on this budget.`);

      await AuditService.record(tx, actor, {
        action: "budget.line_removed",
        entityType: "Budget",
        entityId: budgetId,
        before: { lineId, accountId: deleted.accountId, periodStart: deleted.periodStart, amount: deleted.amount },
      });

      return deleted;
    });
  },

  /**
   * DRAFT → ACTIVE. For a BASELINE budget only, refuses if another ACTIVE
   * BASELINE budget in this org already covers an overlapping period — see
   * `budgets`'s doc comment in src/db/schema.ts for why this is the one
   * structurally-enforced rule in this slice and why REVISED_FORECAST/
   * ROLLING_FORECAST are deliberately exempt from it.
   */
  async activate(actor: Actor, id: string) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const budget = await loadBudgetOr404(tx, actor.organizationId, id);
      if (budget.status !== "DRAFT") {
        throw new InvalidBudgetError(`Budget "${budget.name}" is ${budget.status}, not DRAFT — it cannot be activated.`);
      }

      if (budget.type === "BASELINE") {
        const overlapping = await tx
          .select({ id: budgets.id, name: budgets.name })
          .from(budgets)
          .where(
            and(
              eq(budgets.organizationId, actor.organizationId),
              eq(budgets.type, "BASELINE"),
              eq(budgets.status, "ACTIVE"),
              lte(budgets.periodStart, budget.periodEnd),
              gte(budgets.periodEnd, budget.periodStart),
            ),
          );
        if (overlapping.length > 0) throw new OverlappingActiveBaselineError(overlapping[0]!.name);
      }

      const [updated] = await tx
        .update(budgets)
        .set({ status: "ACTIVE", updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(budgets.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "budget.activated",
        entityType: "Budget",
        entityId: id,
        before: { status: "DRAFT" },
        after: { status: "ACTIVE" },
      });

      return updated;
    });
  },

  async archive(actor: Actor, id: string) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const budget = await loadBudgetOr404(tx, actor.organizationId, id);
      if (budget.status === "ARCHIVED") {
        throw new InvalidBudgetError(`Budget "${budget.name}" is already ARCHIVED.`);
      }

      const [updated] = await tx
        .update(budgets)
        .set({ status: "ARCHIVED", updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(budgets.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "budget.archived",
        entityType: "Budget",
        entityId: id,
        before: { status: budget.status },
        after: { status: "ARCHIVED" },
      });

      return updated;
    });
  },

  /**
   * Creates a new DRAFT ROLLING_FORECAST budget from `sourceBudgetId`:
   * every line on/before `carryForwardAfterDate` is copied through
   * unchanged (history preserved exactly), and every line strictly after it
   * is carried forward as a starting point — see
   * `rolling-forecast.ts`'s `partitionLinesForRollingForecast` for the pure
   * logic. The new budget covers the same `periodStart`–`periodEnd` as its
   * source. Nothing about the source budget is modified; this is purely an
   * on-demand copy, per master spec §36 and this slice's scope note (no
   * job queue exists in this codebase for a true scheduled rolling window).
   */
  async createRollingForecast(actor: Actor, input: CreateRollingForecastInput) {
    assertPermission(actor, "budget:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const source = await loadBudgetOr404(tx, actor.organizationId, input.sourceBudgetId);
      if (!input.name.trim()) throw new InvalidBudgetError("A name is required.");

      const sourceLineRows = await tx
        .select()
        .from(budgetLines)
        .where(and(eq(budgetLines.organizationId, actor.organizationId), eq(budgetLines.budgetId, source.id)));

      const sourceLines: RollingForecastSourceLine[] = sourceLineRows.map((l) => ({
        accountId: l.accountId,
        dimensionValueId: l.dimensionValueId,
        periodStart: l.periodStart.toISOString(),
        periodEnd: l.periodEnd.toISOString(),
        amount: l.amount,
      }));
      const { past, future } = partitionLinesForRollingForecast(sourceLines, input.carryForwardAfterDate);

      const [created] = await tx
        .insert(budgets)
        .values({
          organizationId: actor.organizationId,
          name: input.name.trim(),
          type: "ROLLING_FORECAST",
          status: "DRAFT",
          periodStart: source.periodStart,
          periodEnd: source.periodEnd,
          sourceBudgetId: source.id,
          carryForwardAfterDate: input.carryForwardAfterDate,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create rolling forecast.");

      const allLines = [...past, ...future];
      if (allLines.length > 0) {
        await tx.insert(budgetLines).values(
          allLines.map((l) => ({
            organizationId: actor.organizationId,
            budgetId: created.id,
            accountId: l.accountId,
            dimensionValueId: l.dimensionValueId,
            periodStart: new Date(l.periodStart),
            periodEnd: new Date(l.periodEnd),
            amount: l.amount,
            createdById: actor.userId,
            updatedById: actor.userId,
          })),
        );
      }

      await AuditService.record(tx, actor, {
        action: "budget.rolling_forecast_created",
        entityType: "Budget",
        entityId: created.id,
        after: {
          sourceBudgetId: source.id,
          carryForwardAfterDate: input.carryForwardAfterDate,
          pastLinesCopied: past.length,
          futureLinesCarriedForward: future.length,
        },
      });

      return created;
    });
  },
};
