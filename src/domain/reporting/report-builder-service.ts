import "server-only";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { accountTypeEnum, organizations, savedReports } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { Money } from "@/domain/money/money";
import { sumPostedActivityByAccount, type AccountActivitySum } from "@/domain/ledger/gl-aggregation";
import { normalSignedBalance } from "./financial-statements";
import {
  monthlyColumns,
  precedingRangeOfSameLength,
  quarterlyColumns,
  singleColumn,
  type ReportColumn,
} from "./period-presets";

/**
 * Master spec §33's Report Builder: a generalized, configurable version of
 * the P&L/Balance Sheet grid from Phase 5 Slice 1 — rows (accounts or
 * account-type groups), columns (time periods, optionally a monthly/
 * quarterly breakdown), a measure (balance-as-of vs. period movement), a
 * date-range/account-type/dimension filter, and an optional comparison
 * period. Every number here comes from `sumPostedActivityByAccount` (the
 * same shared aggregation Slice 1's P&L/Balance Sheet/Cash Flow already
 * use) — this module never writes its own SQL aggregate, it only varies
 * which `AccountActivityRange` that shared query is called with and how the
 * resulting rows are grouped/labeled.
 *
 * `ReportBuilderConfig` doubles as the typed, closed-vocabulary query shape
 * that NL reporting's AI-assisted translation (`nl-report-query.ts`) must
 * produce — see that module's doc comment and master spec §34. Validating
 * both a human-built and an AI-translated config through the exact same
 * `ReportBuilderConfigSchema` means there is only ever one code path that
 * turns "what the user asked for" into database queries.
 */

export const REPORT_ACCOUNT_TYPES = accountTypeEnum.enumValues;

export const ReportBuilderConfigSchema = z.object({
  rowGroupBy: z.enum(["ACCOUNT", "ACCOUNT_TYPE"]),
  accountTypes: z.array(z.enum(accountTypeEnum.enumValues)).min(1),
  measure: z.enum(["BALANCE", "MOVEMENT"]),
  periodBreakdown: z.enum(["NONE", "MONTHLY", "QUARTERLY"]),
  /** ISO `YYYY-MM-DD`. For `measure: "BALANCE"`, only `dateTo` is actually used (a balance is cumulative-to-date) — `dateFrom` is still required so a monthly/quarterly breakdown has a start to count columns from. */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dimensionValueId: z.string().uuid().optional(),
  includeComparisonPeriod: z.boolean().optional(),
  includeZeroRows: z.boolean().optional(),
});

export type ReportBuilderConfig = z.infer<typeof ReportBuilderConfigSchema>;

export class InvalidReportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReportConfigError";
  }
}

export class SavedReportNotFoundError extends Error {
  constructor(id: string) {
    super(`Saved report ${id} was not found in this organization.`);
    this.name = "SavedReportNotFoundError";
  }
}

export interface ReportBuilderColumnResult {
  label: string;
  from: string;
  to: string;
}

export interface ReportBuilderRowResult {
  key: string;
  code: string | null;
  name: string;
  type: (typeof accountTypeEnum.enumValues)[number];
  /** Normal-balance-signed decimal strings, one per `columns` entry, in order. */
  values: string[];
  comparisonValue?: string;
}

export interface ReportBuilderResult {
  currency: string;
  columns: ReportBuilderColumnResult[];
  comparisonColumn?: ReportBuilderColumnResult;
  rows: ReportBuilderRowResult[];
  /** Sum of every row's value, per column — a running "Total" footer line. */
  grandTotals: string[];
  comparisonGrandTotal?: string;
}

function parseDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function buildColumns(config: ReportBuilderConfig): ReportColumn[] {
  const range = { from: parseDate(config.dateFrom), to: parseDate(config.dateTo) };
  if (range.to.getTime() < range.from.getTime()) {
    throw new InvalidReportConfigError("dateTo cannot be before dateFrom.");
  }
  switch (config.periodBreakdown) {
    case "MONTHLY":
      return monthlyColumns(range);
    case "QUARTERLY":
      return quarterlyColumns(range);
    case "NONE":
    default:
      return singleColumn(range);
  }
}

async function loadCurrency(tx: TenantDb, organizationId: string): Promise<string> {
  const [org] = await tx.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.baseCurrency ?? "AUD";
}

function rowsToValueByAccount(
  rows: AccountActivitySum[],
  accountTypes: ReportBuilderConfig["accountTypes"],
  currency: string,
): Map<string, { amount: Money; code: string; name: string; type: AccountActivitySum["type"] }> {
  const typeSet = new Set(accountTypes);
  const result = new Map<string, { amount: Money; code: string; name: string; type: AccountActivitySum["type"] }>();
  for (const row of rows) {
    if (!typeSet.has(row.type)) continue;
    result.set(row.accountId, {
      amount: normalSignedBalance(row, currency),
      code: row.code,
      name: row.name,
      type: row.type,
    });
  }
  return result;
}

/**
 * Executes `config` against current data and returns a fully computed
 * report — no caching, no persistence of the result anywhere. Running the
 * same saved config a week later re-queries from scratch, which is the
 * entire point of storing a query rather than a result (see
 * `src/db/schema.ts`'s doc comment on `saved_reports`).
 */
async function runConfig(actor: Actor, config: ReportBuilderConfig): Promise<ReportBuilderResult> {
  assertPermission(actor, "financial_report:read");
  const parsed = ReportBuilderConfigSchema.parse(config);
  const columns = buildColumns(parsed);
  if (columns.length === 0) throw new InvalidReportConfigError("The selected date range produced no columns.");
  if (columns.length > 60) {
    throw new InvalidReportConfigError("That date range and breakdown would produce too many columns (max 60).");
  }

  return withTenant(actor.organizationId, async (tx) => {
    const currency = await loadCurrency(tx, actor.organizationId);

    // Sequential — every query here shares one transaction-bound connection
    // (see ReportingService's identical note, itself citing
    // LedgerService.getJournalEntry).
    const perColumnRows: AccountActivitySum[][] = [];
    for (const column of columns) {
      const range =
        parsed.measure === "BALANCE"
          ? { to: column.to, dimensionValueId: parsed.dimensionValueId }
          : { from: column.from, to: column.to, dimensionValueId: parsed.dimensionValueId };
      perColumnRows.push(await sumPostedActivityByAccount(tx, actor.organizationId, range));
    }

    let comparisonRows: AccountActivitySum[] | undefined;
    let comparisonColumn: ReportColumn | undefined;
    if (parsed.includeComparisonPeriod) {
      const fullRange = { from: parseDate(parsed.dateFrom), to: parseDate(parsed.dateTo) };
      const priorRange = precedingRangeOfSameLength(fullRange);
      comparisonColumn = { label: "Comparison", from: priorRange.from, to: priorRange.to };
      const range =
        parsed.measure === "BALANCE"
          ? { to: priorRange.to, dimensionValueId: parsed.dimensionValueId }
          : { from: priorRange.from, to: priorRange.to, dimensionValueId: parsed.dimensionValueId };
      comparisonRows = await sumPostedActivityByAccount(tx, actor.organizationId, range);
    }

    const perColumnByAccount = perColumnRows.map((rows) => rowsToValueByAccount(rows, parsed.accountTypes, currency));
    const comparisonByAccount = comparisonRows
      ? rowsToValueByAccount(comparisonRows, parsed.accountTypes, currency)
      : undefined;

    const rows: ReportBuilderRowResult[] = [];

    if (parsed.rowGroupBy === "ACCOUNT_TYPE") {
      for (const type of parsed.accountTypes) {
        const values = perColumnByAccount.map((byAccount) => {
          let total = Money.zero(currency);
          for (const entry of byAccount.values()) {
            if (entry.type === type) total = total.add(entry.amount);
          }
          return total;
        });
        if (!parsed.includeZeroRows && values.every((v) => v.isZero())) continue;

        let comparisonValue: Money | undefined;
        if (comparisonByAccount) {
          comparisonValue = Money.zero(currency);
          for (const entry of comparisonByAccount.values()) {
            if (entry.type === type) comparisonValue = comparisonValue.add(entry.amount);
          }
        }

        rows.push({
          key: type,
          code: null,
          name: type.charAt(0) + type.slice(1).toLowerCase(),
          type,
          values: values.map((v) => v.toString()),
          comparisonValue: comparisonValue?.toString(),
        });
      }
    } else {
      const accountIds = new Set<string>();
      for (const byAccount of perColumnByAccount) for (const id of byAccount.keys()) accountIds.add(id);
      if (comparisonByAccount) for (const id of comparisonByAccount.keys()) accountIds.add(id);

      for (const accountId of accountIds) {
        const values = perColumnByAccount.map((byAccount) => byAccount.get(accountId)?.amount ?? Money.zero(currency));
        if (!parsed.includeZeroRows && values.every((v) => v.isZero())) continue;

        const source = perColumnByAccount.find((m) => m.has(accountId))?.get(accountId) ?? comparisonByAccount?.get(accountId);
        if (!source) continue;

        rows.push({
          key: accountId,
          code: source.code,
          name: source.name,
          type: source.type,
          values: values.map((v) => v.toString()),
          comparisonValue: comparisonByAccount?.get(accountId)?.amount.toString(),
        });
      }
      rows.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
    }

    const grandTotals = columns.map((_, i) =>
      rows.reduce((sum, row) => sum.add(Money.of(row.values[i] ?? "0", currency)), Money.zero(currency)).toString(),
    );
    const comparisonGrandTotal = comparisonColumn
      ? rows.reduce((sum, row) => sum.add(Money.of(row.comparisonValue ?? "0", currency)), Money.zero(currency)).toString()
      : undefined;

    return {
      currency,
      columns: columns.map((c) => ({ label: c.label, from: c.from.toISOString(), to: c.to.toISOString() })),
      comparisonColumn: comparisonColumn
        ? { label: comparisonColumn.label, from: comparisonColumn.from.toISOString(), to: comparisonColumn.to.toISOString() }
        : undefined,
      rows,
      grandTotals,
      comparisonGrandTotal,
    };
  });
}

export interface SaveReportInput {
  id?: string;
  name: string;
  description?: string;
  visibility: "PERSONAL" | "ORGANIZATION";
  config: ReportBuilderConfig;
}

export interface SavedReportSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: "PERSONAL" | "ORGANIZATION";
  config: ReportBuilderConfig;
  createdById: string;
  updatedAt: Date;
  mine: boolean;
}

async function loadSavedReportOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.id, id), eq(savedReports.organizationId, organizationId)));
  if (!row) throw new SavedReportNotFoundError(id);
  return row;
}

export const ReportBuilderService = {
  runConfig,

  /** Every saved report the actor may see: their own PERSONAL ones, plus every ORGANIZATION one. */
  async listSavedReports(actor: Actor): Promise<SavedReportSummary[]> {
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(savedReports)
        .where(
          and(
            eq(savedReports.organizationId, actor.organizationId),
            or(eq(savedReports.visibility, "ORGANIZATION"), eq(savedReports.createdById, actor.userId)),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        visibility: r.visibility,
        config: ReportBuilderConfigSchema.parse(r.config),
        createdById: r.createdById,
        updatedAt: r.updatedAt,
        mine: r.createdById === actor.userId,
      }));
    });
  },

  async getSavedReport(actor: Actor, id: string): Promise<SavedReportSummary | null> {
    assertPermission(actor, "financial_report:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(savedReports)
        .where(and(eq(savedReports.id, id), eq(savedReports.organizationId, actor.organizationId)));
      if (!row) return null;
      if (row.visibility === "PERSONAL" && row.createdById !== actor.userId) return null;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        config: ReportBuilderConfigSchema.parse(row.config),
        createdById: row.createdById,
        updatedAt: row.updatedAt,
        mine: row.createdById === actor.userId,
      };
    });
  },

  /** Re-fetches the saved config and runs it fresh — never a cached result, see the module doc comment. */
  async runSavedReport(actor: Actor, id: string): Promise<ReportBuilderResult> {
    const saved = await this.getSavedReport(actor, id);
    if (!saved) throw new SavedReportNotFoundError(id);
    return runConfig(actor, saved.config);
  },

  async saveReport(actor: Actor, input: SaveReportInput): Promise<SavedReportSummary> {
    assertPermission(actor, "financial_report:read");
    assertPermission(actor, "saved_report:manage");
    const name = input.name.trim();
    if (!name) throw new InvalidReportConfigError("A saved report needs a name.");
    const config = ReportBuilderConfigSchema.parse(input.config);

    return withTenant(actor.organizationId, async (tx) => {
      if (input.id) {
        const before = await loadSavedReportOr404(tx, actor.organizationId, input.id);
        if (before.visibility === "PERSONAL" && before.createdById !== actor.userId) {
          throw new SavedReportNotFoundError(input.id);
        }
        const [after] = await tx
          .update(savedReports)
          .set({
            name,
            description: input.description?.trim() || null,
            visibility: input.visibility,
            config,
            updatedAt: new Date(),
            updatedById: actor.userId,
          })
          .where(eq(savedReports.id, input.id))
          .returning();
        if (!after) throw new SavedReportNotFoundError(input.id);

        await AuditService.record(tx, actor, {
          entityType: "SAVED_REPORT",
          entityId: after.id,
          action: "UPDATED",
          before,
          after,
        });

        return {
          id: after.id,
          name: after.name,
          description: after.description,
          visibility: after.visibility,
          config: ReportBuilderConfigSchema.parse(after.config),
          createdById: after.createdById,
          updatedAt: after.updatedAt,
          mine: true,
        };
      }

      const [created] = await tx
        .insert(savedReports)
        .values({
          organizationId: actor.organizationId,
          name,
          description: input.description?.trim() || null,
          visibility: input.visibility,
          config,
          createdById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to save report.");

      await AuditService.record(tx, actor, {
        entityType: "SAVED_REPORT",
        entityId: created.id,
        action: "CREATED",
        after: created,
      });

      return {
        id: created.id,
        name: created.name,
        description: created.description,
        visibility: created.visibility,
        config: ReportBuilderConfigSchema.parse(created.config),
        createdById: created.createdById,
        updatedAt: created.updatedAt,
        mine: true,
      };
    });
  },

  async deleteSavedReport(actor: Actor, id: string): Promise<void> {
    assertPermission(actor, "saved_report:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const before = await loadSavedReportOr404(tx, actor.organizationId, id);
      if (before.visibility === "PERSONAL" && before.createdById !== actor.userId) {
        throw new SavedReportNotFoundError(id);
      }
      await tx.delete(savedReports).where(eq(savedReports.id, id));
      await AuditService.record(tx, actor, {
        entityType: "SAVED_REPORT",
        entityId: id,
        action: "DELETED",
        before,
      });
    });
  },
};
