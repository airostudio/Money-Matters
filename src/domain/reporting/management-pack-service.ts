import "server-only";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { ReportingService, type PeriodRange } from "./reporting-service";
import type { BalanceSheetReport, CashFlowStatement, ProfitAndLossReport } from "./financial-statements";

/**
 * Master spec §33's "management report pack": P&L + Balance Sheet + Cash
 * Flow bundled into one on-demand view, with a short AI-written commentary
 * section. Generated fresh on every request from the exact same
 * `ReportingService` calls the three individual report pages already use —
 * this module adds no new aggregation, only composition. There is no
 * scheduling, emailing, or saved "pack" record: master spec §33 also
 * describes a *scheduled* pack, but no job-queue infrastructure exists in
 * this codebase (see docs/roadmap.md's Phase 2 Slice 2 deferral, carried
 * forward every slice since) to run one on a schedule, so only the
 * on-demand version is built — see docs/roadmap.md's Phase 5 Slice 2 notes.
 *
 * The commentary step follows the same "AI never produces a financial
 * figure" discipline as NL reporting: the model is handed only the already-
 * computed totals (never raw ledger data) and instructed to write prose
 * about them, not to calculate anything. It can still only be as reliable
 * as any text-generation call — there is no schema to validate "the model
 * didn't invent a number in a sentence" the way NL reporting's structured
 * request can be validated — so the commentary is clearly labeled as
 * AI-generated in the UI and never substitutes for the figures themselves,
 * which are always shown alongside it, computed independently.
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface ManagementPack {
  profitAndLoss: ProfitAndLossReport;
  balanceSheet: BalanceSheetReport;
  cashFlow: CashFlowStatement;
  /** `null` when `ANTHROPIC_API_KEY` is unset or the call failed — the pack is still complete and useful without it. */
  commentary: string | null;
}

async function generateCommentary(pack: Omit<ManagementPack, "commentary">, apiKey: string): Promise<string | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: 15_000 });
    const model = process.env.ANTHROPIC_MANAGEMENT_PACK_MODEL || DEFAULT_MODEL;

    const facts = [
      `Total Revenue: ${pack.profitAndLoss.totalRevenue} ${pack.profitAndLoss.currency}`,
      `Total Expenses: ${pack.profitAndLoss.totalExpenses} ${pack.profitAndLoss.currency}`,
      `Net Profit: ${pack.profitAndLoss.netProfit} ${pack.profitAndLoss.currency}`,
      pack.profitAndLoss.netProfitComparison
        ? `Net Profit, comparison period: ${pack.profitAndLoss.netProfitComparison} ${pack.profitAndLoss.currency}`
        : undefined,
      `Total Assets: ${pack.balanceSheet.totalAssets} ${pack.balanceSheet.currency}`,
      `Total Liabilities: ${pack.balanceSheet.totalLiabilities} ${pack.balanceSheet.currency}`,
      `Total Equity: ${pack.balanceSheet.totalEquity} ${pack.balanceSheet.currency}`,
      `Balance Sheet balanced: ${pack.balanceSheet.isBalanced}`,
      `Net Cash from Operating: ${pack.cashFlow.netCashFromOperating} ${pack.cashFlow.currency}`,
      `Net Change in Cash: ${pack.cashFlow.netChangeInCash} ${pack.cashFlow.currency}`,
    ]
      .filter(Boolean)
      .join("\n");

    const message = await client.messages.create({
      model,
      max_tokens: 400,
      system:
        "You write a short (3-5 sentence) plain-English commentary on a small business's financial summary for a " +
        "management report pack. Use ONLY the figures given to you — never calculate, restate with a different " +
        "value, or introduce any number that isn't explicitly listed. Focus on what the figures mean in plain " +
        "terms (profitability, financial position, cash movement), not on restating every number verbatim.",
      messages: [{ role: "user", content: `Here are this period's figures:\n\n${facts}` }],
    });

    const textBlock = message.content.find((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
    return textBlock?.text.trim() || null;
  } catch {
    // Same discipline as every other AI integration here: never surface the
    // raw error, never block the feature — the pack is still complete
    // without commentary.
    return null;
  }
}

export const ManagementPackService = {
  async generate(actor: Actor, period: PeriodRange, asOfDate: Date): Promise<ManagementPack> {
    assertPermission(actor, "financial_report:read");

    // Each call opens its own transaction via `withTenant` (unlike the
    // single-transaction sequencing elsewhere in this module's callees), but
    // run one after another anyway to keep this service's connection usage
    // predictable under the small connection pool a serverless deployment
    // configures (see docs/database.md).
    const profitAndLoss = await ReportingService.getProfitAndLoss(actor, period);
    const balanceSheet = await ReportingService.getBalanceSheet(actor, asOfDate);
    const cashFlow = await ReportingService.getCashFlowStatement(actor, period);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const commentary = apiKey ? await generateCommentary({ profitAndLoss, balanceSheet, cashFlow }, apiKey) : null;

    return { profitAndLoss, balanceSheet, cashFlow, commentary };
  },
};
