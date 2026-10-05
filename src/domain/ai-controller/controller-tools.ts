import "server-only";
import { z } from "zod";
import { type Actor, PermissionDeniedError, assertPermission } from "@/domain/permissions/permission-service";
import type { Permission } from "@/domain/permissions/roles";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { AgedReceivablesService } from "@/domain/sales/aged-receivables-service";
import { AgedPayablesService } from "@/domain/purchases/aged-payables-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { ReportBuilderService, type ReportBuilderConfig } from "@/domain/reporting/report-builder-service";
import { NLReportRequestSchema, resolveNLReportRequest } from "@/domain/reporting/nl-report-query";
import type { DimensionWithValues } from "@/domain/dimensions/dimension-service";
import { PeriodArgSchema, resolvePeriodArg, periodArgLabel } from "./period-arg";
import { formatDateParam } from "@/domain/reporting/period-presets";
import { Money } from "@/domain/money/money";
import { describeUnscheduledKnown } from "@/domain/forecasting/forecast-summary";
import { CashForecastService } from "@/domain/forecasting/cash-forecast-service";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import { checklistFacts } from "@/domain/close/checklist-summary";
import { monthKey, previousMonth } from "@/domain/close/period-ref";
import { GroupService } from "@/domain/consolidation/group-service";
import { ConsolidationService } from "@/domain/consolidation/consolidation-service";
import { MixedCurrencyError } from "@/domain/consolidation/errors";
import { consolidatedSummary } from "@/domain/consolidation/summary";
import { FORECAST_HORIZONS, type CashForecast, type ForecastLine, type KnownForecastLine } from "@/domain/forecasting/types";

/**
 * Master spec §7/§49/§50's "fixed, explicit set of tools" — the ONLY surface
 * the AI Financial Controller (`financial-controller-service.ts`) can touch.
 * Every tool here is a thin wrapper around an already-existing, read-only
 * domain-service method; none of them write SQL, none of them accept a
 * free-form query the model could use to ask for anything beyond what the
 * wrapper's own fixed signature allows, and none of them mutate anything —
 * this slice is deliberately an information assistant, not an action-taking
 * one (see docs/roadmap.md's Phase 6 Slice 1 notes on what's deferred).
 *
 * **The permission check is never skipped, never elevated, and never
 * duplicated with different logic than the UI's own.** Every domain-service
 * method below calls `assertPermission` internally exactly as it does when a
 * route handler calls it directly — these wrappers pass the real,
 * authenticated `Actor` straight through and do nothing to widen what it can
 * see. `executeTool` below is the only place that catches the resulting
 * `PermissionDeniedError` and turns it into a structured refusal the model
 * is instructed to relay honestly, rather than a thrown exception that would
 * otherwise just 500 the request. This is master spec §49's "if a staff
 * member cannot access payroll through the application, 'Show me everyone's
 * salaries' must also be denied by the AI" made concrete — see
 * `src/tests/integration/ai-controller/financial-controller.test.ts` for the
 * end-to-end proof.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DateArgSchema = z.string().regex(DATE_RE).optional();

function parseAsOf(value: string | undefined): Date {
  if (!value) return new Date();
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

export interface ToolCitation {
  tool: string;
  /** Human-readable label for what was queried, e.g. "Profit & Loss". */
  description: string;
  /** e.g. "for last quarter" / "as of 2026-03-31". */
  periodLabel?: string;
  /** Org-relative path (no leading org slug) the UI prefixes with `/${orgSlug}`. */
  drillDownHref?: string;
}

export interface ToolSuccess {
  ok: true;
  /** Plain-text (not JSON) summary hand‑ed back to the model as the tool_result content — small enough to stay well under the model's context budget even for a large aged-receivables list. */
  summary: string;
  citation: ToolCitation;
  /**
   * Set ONLY by a write-capable tool (`write-tools.ts`) that successfully
   * resolved a proposal and stored it PENDING — never by a read-only tool.
   * This is a proposal, not a creation: nothing was written to the ledger,
   * invoices, or bills tables. The chat UI renders `preview` as a distinct
   * "Create this draft?" confirmation card; only a separate, explicit click
   * that invokes `AIDraftProposalService.confirm` actually creates anything.
   * See docs/ai-agents.md's proposal/confirmation design.
   */
  proposal?: { id: string; preview: import("./draft-proposal-service").DraftProposalPreview };
}

export interface ToolFailure {
  ok: false;
  /** Shown to the model (and, verbatim, is safe to relay to the user — never a stack trace). */
  error: string;
}

export type ToolOutcome = ToolSuccess | ToolFailure;

export interface ControllerToolDefinition {
  name: string;
  description: string;
  /** JSON Schema handed to Claude's tool-use `input_schema`. */
  inputSchema: Record<string, unknown>;
  /** Re-validated against this before the tool runs, exactly like every other AI integration's output in this codebase. */
  argsSchema: z.ZodType;
  /** The permission the underlying domain-service call enforces — documented here for tests/audits, not itself enforced a second time (the domain service is the single source of truth). */
  permission: Permission;
  execute: (actor: Actor, args: unknown) => Promise<ToolOutcome>;
}

const ConsolidatedReportArgsSchema = z.object({
  report: z.enum(["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH"]),
  group: z.string().min(1).max(200).optional(),
  period: PeriodArgSchema.optional(),
  asOfDate: DateArgSchema,
});

function truncate<T>(list: T[], max: number): { shown: T[]; omitted: number } {
  return { shown: list.slice(0, max), omitted: Math.max(0, list.length - max) };
}

async function guarded(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return {
        ok: false,
        error: `Access denied: your role does not have the "${err.permission}" permission needed for this, the same as it would be denied in the application itself.`,
      };
    }
    return { ok: false, error: "That lookup could not be completed." };
  }
}

/**
 * Builds the tool registry. Takes the organization's active dimensions
 * (already loaded once per conversation, never re-fetched per tool call) so
 * `run_report`'s dimension matching follows the exact same "only ever trust
 * a dimension name that is actually real" discipline as NL reporting — see
 * `nl-report-query.ts`.
 */
export function buildControllerTools(dimensions: DimensionWithValues[]): ControllerToolDefinition[] {
  return [
    {
      name: "trial_balance",
      description:
        "Get the Trial Balance: every account's posted balance as of a date. Use for 'what is our balance in X account' or an overview of account balances.",
      inputSchema: {
        type: "object",
        properties: { asOfDate: { type: "string", description: "YYYY-MM-DD, defaults to today." } },
      },
      argsSchema: z.object({ asOfDate: DateArgSchema }),
      permission: "journal:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ asOfDate: DateArgSchema }).parse(rawArgs);
          const asOfDate = parseAsOf(args.asOfDate);
          const rows = await LedgerService.getTrialBalance(actor, asOfDate);
          const nonZero = rows.filter((r) => Number(r.balance) !== 0);
          const { shown, omitted } = truncate(nonZero, 40);
          const lines = shown.map((r: any) => `${r.code} ${r.name} (${r.type}): ${r.balance}`);
          const dateLabel = formatDateParam(asOfDate);
          return {
            ok: true,
            summary: `Trial balance as of ${dateLabel} (account: normal-balance-signed amount in org base currency):\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more accounts.` : ""}`,
            citation: { tool: "trial_balance", description: "Trial Balance", periodLabel: `as of ${dateLabel}`, drillDownHref: `/accounting/trial-balance?asOf=${dateLabel}` },
          };
        }),
    },
    {
      name: "profit_and_loss",
      description: "Get the Profit & Loss (revenue, expenses, net profit) for a period. Use for revenue/expense/profit questions.",
      inputSchema: {
        type: "object",
        properties: { period: periodArgJsonSchema() },
        required: ["period"],
      },
      argsSchema: z.object({ period: PeriodArgSchema }),
      permission: "financial_report:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ period: PeriodArgSchema }).parse(rawArgs);
          const range = resolvePeriodArg(args.period);
          const report = await ReportingService.getProfitAndLoss(actor, range);
          const label = periodArgLabel(args.period, range);
          const from = formatDateParam(range.from);
          const to = formatDateParam(range.to);
          return {
            ok: true,
            summary: `Profit & Loss for ${label} (${from} to ${to}): Total Revenue ${report.totalRevenue} ${report.currency}, Total Expenses ${report.totalExpenses} ${report.currency}, Net Profit ${report.netProfit} ${report.currency}.`,
            citation: { tool: "profit_and_loss", description: "Profit & Loss", periodLabel: label, drillDownHref: `/accounting/reports/profit-and-loss?from=${from}&to=${to}` },
          };
        }),
    },
    {
      name: "balance_sheet",
      description: "Get the Balance Sheet (assets, liabilities, equity) as of a date. Use for 'what do we own/owe' and cash/asset position questions.",
      inputSchema: {
        type: "object",
        properties: { asOfDate: { type: "string", description: "YYYY-MM-DD, defaults to today." } },
      },
      argsSchema: z.object({ asOfDate: DateArgSchema }),
      permission: "financial_report:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ asOfDate: DateArgSchema }).parse(rawArgs);
          const asOfDate = parseAsOf(args.asOfDate);
          const report = await ReportingService.getBalanceSheet(actor, asOfDate);
          const dateLabel = formatDateParam(asOfDate);
          return {
            ok: true,
            summary: `Balance Sheet as of ${dateLabel}: Total Assets ${report.totalAssets} ${report.currency}, Total Liabilities ${report.totalLiabilities} ${report.currency}, Total Equity ${report.totalEquity} ${report.currency}.`,
            citation: { tool: "balance_sheet", description: "Balance Sheet", periodLabel: `as of ${dateLabel}`, drillDownHref: `/accounting/reports/balance-sheet?asOf=${dateLabel}` },
          };
        }),
    },
    {
      name: "aged_receivables",
      description: "Who owes us money: unpaid customer invoices grouped by customer with aging buckets and a collection priority score (who to chase first). Use for 'who owes us money' / 'overdue invoices' / outstanding AR questions.",
      inputSchema: {
        type: "object",
        properties: { asOfDate: { type: "string", description: "YYYY-MM-DD, defaults to today." } },
      },
      argsSchema: z.object({ asOfDate: DateArgSchema }),
      permission: "customer_invoice:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ asOfDate: DateArgSchema }).parse(rawArgs);
          const asOfDate = parseAsOf(args.asOfDate);
          const rows = await AgedReceivablesService.getWithPriority(actor, asOfDate);
          const { shown, omitted } = truncate(rows, 20);
          const total = rows.reduce((sum, r) => sum + Number(r.outstanding), 0);
          const lines = shown.map(
            (r: any) =>
              `${r.customerName} — invoice ${r.invoiceNumber}: ${r.outstanding} outstanding, ${r.daysPastDue > 0 ? `${r.daysPastDue} days overdue` : "not yet due"} (priority score ${r.priorityScore})`,
          );
          const dateLabel = formatDateParam(asOfDate);
          return {
            ok: true,
            summary: `Aged Receivables as of ${dateLabel}: ${rows.length} unpaid invoice(s) totaling ${total.toFixed(2)}, sorted by collection priority:\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more.` : ""}`,
            citation: { tool: "aged_receivables", description: "Aged Receivables", periodLabel: `as of ${dateLabel}`, drillDownHref: "/sales/aged-receivables" },
          };
        }),
    },
    {
      name: "aged_payables",
      description: "Who we owe money to: unpaid supplier bills grouped by supplier with aging buckets. Use for 'what do we owe' / 'overdue bills' / outstanding AP questions.",
      inputSchema: {
        type: "object",
        properties: { asOfDate: { type: "string", description: "YYYY-MM-DD, defaults to today." } },
      },
      argsSchema: z.object({ asOfDate: DateArgSchema }),
      permission: "supplier_bill:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ asOfDate: DateArgSchema }).parse(rawArgs);
          const asOfDate = parseAsOf(args.asOfDate);
          const rows = await AgedPayablesService.get(actor, asOfDate);
          const { shown, omitted } = truncate(rows, 20);
          const lines = shown.map((r) => `${r.supplierName}: ${r.totalOutstanding} outstanding across ${r.bills.length} bill(s)`);
          const dateLabel = formatDateParam(asOfDate);
          return {
            ok: true,
            summary: `Aged Payables as of ${dateLabel}:\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more suppliers.` : ""}`,
            citation: { tool: "aged_payables", description: "Aged Payables", periodLabel: `as of ${dateLabel}`, drillDownHref: "/purchases/aged-payables" },
          };
        }),
    },
    {
      name: "cash_forecast",
      description:
        "Forecast the organization's cash balance forward from today (7D, 30D, 60D, 90D or 12M) and warn when it may run low. " +
        "Returns TWO separate projections that must never be blended: KNOWN commitments only (open invoices at their due dates, open bills, approved payment runs, scheduled recurring invoices/bills) and one INCLUDING statistical projections (timing shifts based on each customer's historical average lateness, a repeat of the last pay run). " +
        "Use for 'when might we run low on cash?', 'what will our cash look like in 60 days?', cash runway/low-point questions. Always say which projection a statement refers to.",
      inputSchema: {
        type: "object",
        properties: {
          horizon: { type: "string", enum: [...FORECAST_HORIZONS], description: "Forecast horizon, defaults to 90D." },
          asOfDate: { type: "string", description: "YYYY-MM-DD start date, defaults to today." },
        },
      },
      argsSchema: z.object({ horizon: z.enum(FORECAST_HORIZONS).optional(), asOfDate: DateArgSchema }),
      permission: "forecast:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ horizon: z.enum(FORECAST_HORIZONS).optional(), asOfDate: DateArgSchema }).parse(rawArgs);
          const asOfDate = parseAsOf(args.asOfDate);
          const horizon = args.horizon ?? "90D";
          const f = await CashForecastService.generate(actor, { asOfDate, horizon });
          return {
            ok: true,
            summary: cashForecastSummary(f),
            citation: {
              tool: "cash_forecast",
              description: "Cash Forecast",
              periodLabel: `${horizon} from ${f.asOf}`,
              drillDownHref: `/forecasting/cash-flow?horizon=${horizon}&asOf=${f.asOf}`,
            },
          };
        }),
    },
    {
      name: "close_status",
      description:
        "Read-only status of a month-end close: how complete it is, what is blocking it, what needs attention, and which items still await a person's sign-off. " +
        "Use for 'is last month ready to close?', 'what is left before we close March?'. Defaults to the previous calendar month. " +
        "You can only REPORT status — you can never close, lock, reopen or sign off a period; closing is always done by a human in the application. " +
        "Items signed off by a person are not system-verified: say which is which.",
      inputSchema: {
        type: "object",
        properties: { month: { type: "string", description: "YYYY-MM, defaults to the previous month." } },
      },
      argsSchema: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }),
      permission: "close_checklist:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(rawArgs);
          const now = new Date();
          const prev = previousMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
          const key = args.month ?? monthKey(prev.year, prev.month);
          const checklist = await CloseChecklistService.compute(actor, key);
          return {
            ok: true,
            summary: checklistFacts(checklist).join("\n"),
            citation: {
              tool: "close_status",
              description: "Month-end close status",
              periodLabel: key,
              drillDownHref: `/accounting/close/${key}`,
            },
          };
        }),
    },
    {
      name: "consolidated_report",
      description:
        "Read-only CONSOLIDATED report across the entities of one of the user's entity groups (multi-company): consolidated Profit & Loss, Balance Sheet or cash position, with per-entity figures, intercompany eliminations and the intercompany reconciliation exceptions. " +
        "Use for 'what is the group's total cash', 'consolidated profit this quarter', 'does the group balance sheet balance'. " +
        "It covers ONLY the entities this user is permitted to read: every entity is checked with the user's own role in that entity, and any entity they cannot access is left out and reported only as a count (\"N entities excluded — no access\") — you must repeat that notice if it is present and must never guess at, estimate or describe an excluded entity. " +
        "If the tool reports an intercompany mismatch or unmapped accounts, say so rather than presenting the total as final. You cannot change groups, mappings or adjustments from here.",
      inputSchema: {
        type: "object",
        properties: {
          report: { type: "string", enum: ["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH"] },
          group: { type: "string", description: "The entity group's name. Optional when the user has exactly one group." },
          period: periodArgJsonSchema(),
          asOfDate: { type: "string", description: "YYYY-MM-DD for BALANCE_SHEET / CASH, defaults to today." },
        },
        required: ["report"],
      },
      argsSchema: ConsolidatedReportArgsSchema,
      permission: "financial_report:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = ConsolidatedReportArgsSchema.parse(rawArgs);

          // Same gate as every other report tool in the organization the user is chatting in; the
          // per-ENTITY gates (the user's real role in each group entity) are applied inside the service.
          assertPermission(actor, "financial_report:read");
          const groupActor = { userId: actor.userId, type: "AI" as const };

          const groups = await GroupService.list(groupActor);
          if (groups.length === 0) {
            return { ok: true, summary: "This user has no entity groups set up, so there is nothing to consolidate.", citation: { tool: "consolidated_report", description: "Consolidated report" } };
          }
          const wanted = args.group?.trim().toLowerCase();
          const exact = wanted ? groups.filter((g) => g.name.toLowerCase() === wanted) : [];
          const partial = wanted ? groups.filter((g) => g.name.toLowerCase().includes(wanted)) : [];
          const candidates = wanted ? (exact.length > 0 ? exact : partial) : groups;
          if (candidates.length !== 1) {
            return {
              ok: true,
              summary: `Which entity group? This user's groups are: ${groups.map((g) => g.name).join(", ")}. Ask the user to pick one.`,
              citation: { tool: "consolidated_report", description: "Entity groups" },
            };
          }
          const group = candidates[0]!;

          try {
            if (args.report === "PROFIT_AND_LOSS") {
              const period = args.period ?? { kind: "THIS_YEAR" as const };
              const range = resolvePeriodArg(period);
              const report = await ConsolidationService.profitAndLoss(groupActor, group.id, range);
              return {
                ok: true,
                summary: consolidatedSummary.profitAndLoss(report, `${formatDateParam(range.from)} to ${formatDateParam(range.to)}`),
                citation: { tool: "consolidated_report", description: `Consolidated Profit & Loss — ${group.name}`, periodLabel: periodArgLabel(period, range) },
              };
            }
            const asOfDate = parseAsOf(args.asOfDate);
            const dateLabel = formatDateParam(asOfDate);
            if (args.report === "BALANCE_SHEET") {
              const report = await ConsolidationService.balanceSheet(groupActor, group.id, asOfDate);
              return {
                ok: true,
                summary: consolidatedSummary.balanceSheet(report, dateLabel),
                citation: { tool: "consolidated_report", description: `Consolidated Balance Sheet — ${group.name}`, periodLabel: `as of ${dateLabel}` },
              };
            }
            const report = await ConsolidationService.cash(groupActor, group.id, asOfDate);
            return {
              ok: true,
              summary: consolidatedSummary.cash(report, dateLabel),
              citation: { tool: "consolidated_report", description: `Consolidated cash position — ${group.name}`, periodLabel: `as of ${dateLabel}` },
            };
          } catch (err) {
            // The refusal text names only currencies of entities the user can read.
            if (err instanceof MixedCurrencyError) return { ok: false, error: err.message };
            throw err;
          }
        }),
    },
    {
      name: "find_invoice",
      description: "Look up a specific customer invoice by its invoice number or customer name.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "An invoice number or (part of) a customer name." } },
        required: ["query"],
      },
      argsSchema: z.object({ query: z.string().min(1).max(200) }),
      permission: "customer_invoice:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ query: z.string().min(1).max(200) }).parse(rawArgs);
          const q = args.query.toLowerCase();
          const all = await InvoiceService.list(actor);
          const matches = all.filter(
            (inv) => inv.invoiceNumber.toLowerCase().includes(q) || inv.customer.displayName.toLowerCase().includes(q),
          );
          if (matches.length === 0) return { ok: true, summary: `No invoices matched "${args.query}".`, citation: { tool: "find_invoice", description: `Invoice search: "${args.query}"` } };
          const { shown, omitted } = truncate(matches, 10);
          const lines = shown.map((inv: any) => `${inv.invoiceNumber} — ${inv.customer.displayName}: total ${inv.total} ${inv.currency}, paid ${inv.amountPaid}, status ${inv.status}, due ${new Date(inv.dueDate).toISOString().slice(0, 10)}`);
          const first = shown[0] as any;
          return {
            ok: true,
            summary: `${matches.length} invoice(s) matched "${args.query}":\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more.` : ""}`,
            citation: { tool: "find_invoice", description: `Invoice ${first.invoiceNumber}`, drillDownHref: `/sales/invoices/${first.id}` },
          };
        }),
    },
    {
      name: "find_bill",
      description: "Look up a specific supplier bill by its bill number or supplier name.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "A bill number or (part of) a supplier name." } },
        required: ["query"],
      },
      argsSchema: z.object({ query: z.string().min(1).max(200) }),
      permission: "supplier_bill:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z.object({ query: z.string().min(1).max(200) }).parse(rawArgs);
          const q = args.query.toLowerCase();
          const all = await BillService.list(actor);
          const matches = all.filter(
            (bill) => bill.billNumber.toLowerCase().includes(q) || bill.supplier.displayName.toLowerCase().includes(q),
          );
          if (matches.length === 0) return { ok: true, summary: `No bills matched "${args.query}".`, citation: { tool: "find_bill", description: `Bill search: "${args.query}"` } };
          const { shown, omitted } = truncate(matches, 10);
          const lines = shown.map((bill: any) => `${bill.billNumber} — ${bill.supplier.displayName}: total ${bill.total} ${bill.currency}, paid ${bill.amountPaid}, status ${bill.status}, due ${new Date(bill.dueDate).toISOString().slice(0, 10)}`);
          const first = shown[0] as any;
          return {
            ok: true,
            summary: `${matches.length} bill(s) matched "${args.query}":\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more.` : ""}`,
            citation: { tool: "find_bill", description: `Bill ${first.billNumber}`, drillDownHref: `/purchases/bills/${first.id}` },
          };
        }),
    },
    {
      name: "find_expense_claim",
      description:
        "Look up expense claims by claim number and/or status. A non-approver only ever sees their own claims, exactly as the Expenses page does.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A claim number, or part of one. Omit to list recent claims." },
          status: { type: "string", enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "REIMBURSED", "VOID"] },
        },
      },
      argsSchema: z.object({
        query: z.string().max(200).optional(),
        status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "REIMBURSED", "VOID"]).optional(),
      }),
      permission: "expense_claim:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const args = z
            .object({
              query: z.string().max(200).optional(),
              status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "REIMBURSED", "VOID"]).optional(),
            })
            .parse(rawArgs);
          const all = await ExpenseClaimService.list(actor, { status: args.status });
          const q = args.query?.toLowerCase();
          const matches = q ? all.filter((c) => c.claimNumber.toLowerCase().includes(q)) : all;
          if (matches.length === 0) return { ok: true, summary: "No expense claims matched.", citation: { tool: "find_expense_claim", description: "Expense claim search" } };
          const { shown, omitted } = truncate(matches, 10);
          const lines = shown.map((c: any) => `${c.claimNumber}: ${c.total} ${c.currency}, status ${c.status}, claim date ${new Date(c.claimDate).toISOString().slice(0, 10)}`);
          const first = shown[0] as any;
          return {
            ok: true,
            summary: `${matches.length} expense claim(s):\n${lines.join("\n")}${omitted ? `\n...and ${omitted} more.` : ""}`,
            citation: { tool: "find_expense_claim", description: `Expense claim ${first.claimNumber}`, drillDownHref: `/expenses/${first.id}` },
          };
        }),
    },
    {
      name: "run_report",
      description:
        "For any other reporting question not covered by the other tools (e.g. a specific expense category, a breakdown by month, a comparison, or a question about a specific dimension like a project or department). Translate the question into one of six metrics, a period, an optional monthly/quarterly breakdown, and — ONLY if the question clearly names one of this organization's real dimensions — a dimension filter. " +
        (dimensions.length > 0
          ? `Known dimensions in this organization: ${dimensions.map((d) => `${d.name} (values: ${d.values.map((v) => v.label).join(", ") || "none yet"})`).join("; ")}.`
          : "This organization has no dimensions configured — never set dimensionKey/dimensionValue."),
      inputSchema: {
        type: "object",
        properties: {
          metric: { type: "string", enum: ["REVENUE", "EXPENSES", "NET_PROFIT", "ASSETS", "LIABILITIES", "EQUITY"] },
          period: periodArgJsonSchema(),
          breakdown: { type: "string", enum: ["NONE", "MONTHLY", "QUARTERLY"] },
          dimensionKey: { type: "string", description: "Exact name of a known dimension, only if clearly referenced." },
          dimensionValue: { type: "string", description: "Exact value label for dimensionKey, only if dimensionKey is set." },
          compareToPriorPeriod: { type: "boolean" },
        },
        required: ["metric", "period", "breakdown"],
      },
      argsSchema: NLReportRequestSchema,
      permission: "financial_report:read",
      execute: (actor, rawArgs) =>
        guarded(async () => {
          const request = NLReportRequestSchema.parse(rawArgs);
          const resolved = resolveNLReportRequest(request, { dimensions });
          if ("error" in resolved) return { ok: false, error: resolved.error };
          const result = await ReportBuilderService.runConfig(actor, resolved.config);
          const lines = result.rows.map((r) => `${r.name}: ${r.values.join(", ")} ${result.currency}${r.comparisonValue ? ` (prior period: ${r.comparisonValue})` : ""}`);
          return {
            ok: true,
            summary: `${resolved.restatement}. Columns: ${result.columns.map((c) => c.label).join(", ")}.\n${lines.join("\n")}`,
            citation: { tool: "run_report", description: resolved.restatement, drillDownHref: builderHref(resolved.config) },
          };
        }),
    },
  ];
}

/**
 * Plain-text rendering of a `CashForecast` for the model. KNOWN and
 * STATISTICAL figures sit under separate, loudly-labelled headings — the tool
 * can't blur the §38 distinction, so the assistant can't either. Payroll
 * lines appear only if the forecast itself contained them (it omits them for
 * an actor without `payrun:read`) and a notice says when they were omitted.
 */
function cashForecastSummary(f: CashForecast): string {
  const top = (lines: ForecastLine[], n: number) =>
    [...lines]
      .sort((a, b) => Money.of(b.amount, "XXX").compareTo(Money.of(a.amount, "XXX")))
      .slice(0, n)
      .map(
        (l) =>
          `  - ${l.direction === "IN" ? "IN" : "OUT"} ${l.amount} ${l.date ?? "undated"}: ${l.label}${l.counterparty ? ` (${l.counterparty})` : ""}` +
          (l.kind === "STATISTICAL" ? ` [expected date; based on ${l.basis.type === "CUSTOMER_AVG_DAYS_LATE" ? `customer avg ${l.basis.avgDaysLate} days late over ${l.basis.settledInvoiceCount ?? "?"} settled invoice(s)` : "repeat of last pay run"}]` : l.timing === "UNVERIFIED" ? " [amount known, due date NOT verified]" : ""),
      );
  const known = f.lines.filter((l): l is KnownForecastLine => l.kind === "KNOWN");
  const statistical = f.lines.filter((l) => l.kind === "STATISTICAL");
  const out = [
    `Cash forecast from ${f.asOf}, ${f.horizon} horizon (${f.currency}). Opening cash (ledger balance of bank accounts): ${f.openingCash.total}.`,
    `KNOWN COMMITMENTS ONLY (grounded in invoices, bills, approved payment runs, scheduled recurring templates): ends at ${f.knownOnly.endBalance}; lowest ${f.knownOnly.lowPoint.balance} on ${f.knownOnly.lowPoint.date}; known money in ${f.knownOnly.totalIn}, known money out ${f.knownOnly.totalOut}.`,
    `INCLUDING STATISTICAL PROJECTIONS (ESTIMATES from simple historical averages, NOT certain): ends at ${f.withStatistical.endBalance}; lowest ${f.withStatistical.lowPoint.balance} on ${f.withStatistical.lowPoint.date}.`,
    f.warning.message
      ? `LOW-CASH WARNING (threshold ${f.lowCashThreshold}): ${f.warning.message}`
      : `No low-cash warning: neither projection falls below the threshold of ${f.lowCashThreshold} within the horizon.`,
  ];
  const unscheduled = describeUnscheduledKnown(f);
  if (unscheduled) out.push(unscheduled);
  out.push(`Largest KNOWN lines:\n${top(known, 8).join("\n") || "  (none)"}`);
  out.push(`Largest STATISTICAL lines (estimates):\n${top(statistical, 8).join("\n") || "  (none)"}`);
  if (f.payrollOmitted) out.push("Note: payroll-derived lines are omitted because this user's role cannot read pay runs, so outflows may be understated.");
  return out.join("\n");
}

function periodArgJsonSchema() {
  return {
    type: "object",
    description: "The time period the question refers to.",
    properties: {
      kind: {
        type: "string",
        enum: ["THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "LAST_QUARTER", "THIS_YEAR", "LAST_YEAR", "LAST_N_MONTHS", "LAST_N_QUARTERS", "CUSTOM"],
      },
      n: { type: "number", description: "Only for LAST_N_MONTHS/LAST_N_QUARTERS." },
      from: { type: "string", description: "Only for CUSTOM, format YYYY-MM-DD." },
      to: { type: "string", description: "Only for CUSTOM, format YYYY-MM-DD." },
    },
    required: ["kind"],
  };
}

function builderHref(config: ReportBuilderConfig): string {
  const params = new URLSearchParams();
  params.set("rowGroupBy", config.rowGroupBy);
  for (const t of config.accountTypes) params.append("accountTypes", t);
  params.set("measure", config.measure);
  params.set("periodBreakdown", config.periodBreakdown);
  params.set("dateFrom", config.dateFrom);
  params.set("dateTo", config.dateTo);
  if (config.dimensionValueId) params.set("dimension", config.dimensionValueId);
  if (config.includeComparisonPeriod) params.set("compare", "1");
  return `/accounting/reports/builder?${params.toString()}`;
}
