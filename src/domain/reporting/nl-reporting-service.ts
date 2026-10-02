import "server-only";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { DimensionService, type DimensionWithValues } from "@/domain/dimensions/dimension-service";
import { NLReportRequestSchema, resolveNLReportRequest, type NLReportRequest } from "./nl-report-query";
import { ReportBuilderService, type ReportBuilderConfig, type ReportBuilderResult } from "./report-builder-service";

/**
 * Orchestrates master spec §34's full pipeline end to end: interpret (AI,
 * schema-constrained tool call) → structured request (zod-validated,
 * `NLReportRequest`) → deterministic resolution into a `ReportBuilderConfig`
 * (`resolveNLReportRequest`) → deterministic execution
 * (`ReportBuilderService.runConfig`, the exact same engine the report
 * builder UI uses). See `nl-report-query.ts`'s doc comment for the full
 * quote and why the AI's output stops at a structured request.
 *
 * Unlike `recommendChartOfAccounts` (docs/ai-agents.md §0), there is no
 * deterministic fallback that *answers the question* when the AI is
 * unavailable — a keyword guess at "what report did they mean" would risk
 * silently showing the wrong numbers for a different question, which is
 * explicitly what this feature must never do. The fallback here is
 * `{ available: false }`: the caller shows "natural-language queries aren't
 * available right now" and points the user at the report builder directly.
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const INTERPRET_TOOL_NAME = "structure_report_request";

export type NLReportingOutcome =
  | { status: "ok"; restatement: string; result: ReportBuilderResult; config: ReportBuilderConfig }
  | { status: "clarification_needed"; message: string }
  | { status: "unavailable"; reason: string };

function buildToolSchema(dimensions: DimensionWithValues[]) {
  const dimensionHint =
    dimensions.length > 0
      ? `Known dimensions in this organization: ${dimensions
          .map((d) => `${d.name} (values: ${d.values.map((v) => v.label).join(", ") || "none yet"})`)
          .join("; ")}.`
      : "This organization has no dimensions configured yet — never set dimensionKey/dimensionValue.";

  return {
    name: INTERPRET_TOOL_NAME,
    description:
      "Translate a plain-English financial reporting question into a small structured request. " +
      "Never compute or state any number — only classify the question into these fields. " +
      dimensionHint,
    input_schema: {
      type: "object" as const,
      properties: {
        metric: {
          type: "string",
          enum: ["REVENUE", "EXPENSES", "NET_PROFIT", "ASSETS", "LIABILITIES", "EQUITY"],
          description: "Which figure the question is asking about.",
        },
        period: {
          type: "object",
          description: "The time period the question refers to.",
          properties: {
            kind: {
              type: "string",
              enum: [
                "THIS_MONTH",
                "LAST_MONTH",
                "THIS_QUARTER",
                "LAST_QUARTER",
                "THIS_YEAR",
                "LAST_YEAR",
                "LAST_N_MONTHS",
                "LAST_N_QUARTERS",
                "CUSTOM",
              ],
            },
            n: { type: "number", description: "Only for LAST_N_MONTHS/LAST_N_QUARTERS." },
            from: { type: "string", description: "Only for CUSTOM, format YYYY-MM-DD." },
            to: { type: "string", description: "Only for CUSTOM, format YYYY-MM-DD." },
          },
          required: ["kind"],
        },
        breakdown: {
          type: "string",
          enum: ["NONE", "MONTHLY", "QUARTERLY"],
          description: "Whether the question wants the figure split into sub-periods (e.g. 'by month').",
        },
        dimensionKey: {
          type: "string",
          description:
            "The exact name of one of the known dimensions listed above, ONLY if the question clearly refers to one. Omit otherwise — never invent a dimension name.",
        },
        dimensionValue: {
          type: "string",
          description: "The exact value label for dimensionKey, ONLY if dimensionKey is set.",
        },
        compareToPriorPeriod: {
          type: "boolean",
          description: "True if the question asks to compare against the prior equivalent period.",
        },
      },
      required: ["metric", "period", "breakdown"],
    },
  };
}

async function interpretWithAi(
  question: string,
  dimensions: DimensionWithValues[],
  apiKey: string,
): Promise<NLReportRequest> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: 15_000 });
  const model = process.env.ANTHROPIC_NL_REPORTING_MODEL || DEFAULT_MODEL;

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system:
      "You translate a plain-English financial reporting question into a small structured request by calling " +
      "the structure_report_request tool. You NEVER answer the question, state a number, or invent data — your " +
      "only job is classification into the tool's fixed fields. If the question doesn't clearly map to one of " +
      "the six metrics or a period you can express with the given period kinds, still make your best single " +
      "classification — the caller independently validates and resolves every field, including rejecting a " +
      "dimension reference that doesn't match a real one, so you do not need to hedge.",
    messages: [{ role: "user", content: question }],
    tools: [buildToolSchema(dimensions)],
    tool_choice: { type: "tool", name: INTERPRET_TOOL_NAME },
  });

  const toolUse = message.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
  );
  if (!toolUse) throw new Error("AI response did not include a structure_report_request tool call.");

  const parsed = NLReportRequestSchema.safeParse(toolUse.input);
  if (!parsed.success) throw new Error(`AI response failed schema validation: ${parsed.error.message}`);
  return parsed.data;
}

export const NLReportingService = {
  /**
   * The full pipeline for one question. Gated on the same
   * `financial_report:read` permission as running any other report — asking
   * a question is just another way to run one, never a wider grant.
   */
  async ask(actor: Actor, question: string): Promise<NLReportingOutcome> {
    assertPermission(actor, "financial_report:read");

    const trimmed = question.trim();
    if (!trimmed) return { status: "clarification_needed", message: "Please type a question first." };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        status: "unavailable",
        reason: "Natural-language reporting isn't configured in this environment.",
      };
    }

    const dimensions = await DimensionService.listActive(actor);

    let request: NLReportRequest;
    try {
      request = await interpretWithAi(trimmed, dimensions, apiKey);
    } catch {
      // Never surface the raw error, timeout, or network failure — same UX
      // discipline as every other AI integration in this codebase (see
      // docs/ai-agents.md). Unlike those, there is no deterministic
      // fallback that answers the question — see this module's doc comment.
      return {
        status: "unavailable",
        reason: "Natural-language reporting is temporarily unavailable. Try the report builder directly.",
      };
    }

    const resolved = resolveNLReportRequest(request, { dimensions });
    if ("error" in resolved) {
      return { status: "clarification_needed", message: resolved.error };
    }

    const result = await ReportBuilderService.runConfig(actor, resolved.config);
    return { status: "ok", restatement: resolved.restatement, result, config: resolved.config };
  },
};
