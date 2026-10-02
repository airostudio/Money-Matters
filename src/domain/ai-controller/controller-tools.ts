import "server-only";
import { z } from "zod";
import { type Actor, PermissionDeniedError } from "@/domain/permissions/permission-service";
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
