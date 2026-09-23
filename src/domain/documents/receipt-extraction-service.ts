import "server-only";
import { z } from "zod";

/**
 * The ONLY thing Document AI is allowed to produce: structured fields
 * extracted from a receipt/invoice image or PDF, re-validated with zod
 * regardless of the API-level schema constraint — the same discipline as
 * `src/domain/onboarding/chart-of-accounts-recommender.ts`. This is always
 * a *suggestion* that pre-fills a draft expense claim line or bill; nothing
 * here is ever posted or saved without a human reviewing and confirming it
 * — master spec §17 ("never silently post uncertain OCR results"). See
 * docs/ai-agents.md.
 */
export const ReceiptLineItemSchema = z.object({
  description: z.string().min(1).max(500),
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, "amount must be a plain decimal string"),
});

export const ReceiptExtractionSchema = z.object({
  supplierName: z.string().min(1).max(200).nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .nullable(),
  subtotal: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullable(),
  taxAmount: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullable(),
  total: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullable(),
  currency: z.string().length(3).nullable(),
  lineItems: z.array(ReceiptLineItemSchema).max(50),
  suggestedCategory: z.string().max(100).nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema> & { model: string };

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const EXTRACT_TOOL_NAME = "extract_receipt";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SUPPORTED_PDF_TYPE = "application/pdf";

/**
 * AI-backed extractor using Claude's vision capability. The model NEVER
 * writes to any table directly — its entire output is this schema, used
 * only to pre-fill an editable draft (`ExpenseClaimService`/`BillService`
 * create calls, which run their own independent validation regardless of
 * what came from here). An invalid/unparseable response is a hard failure,
 * letting the caller fall back to a blank draft rather than guessing.
 */
export class AiReceiptExtractor {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = process.env.ANTHROPIC_DOCUMENT_AI_MODEL || DEFAULT_MODEL,
    private readonly timeoutMs: number = 30_000,
  ) {}

  async extract(input: { mimeType: string; base64Data: string }): Promise<ReceiptExtraction> {
    if (!SUPPORTED_IMAGE_TYPES.has(input.mimeType) && input.mimeType !== SUPPORTED_PDF_TYPE) {
      throw new Error(`Unsupported document type for extraction: ${input.mimeType}`);
    }

    // Lazy import so the SDK is never pulled in when no API key is configured.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey, timeout: this.timeoutMs });

    const documentBlock =
      input.mimeType === SUPPORTED_PDF_TYPE
        ? {
            type: "document" as const,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: input.base64Data },
          }
        : {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: input.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: input.base64Data,
            },
          };

    const message = await client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system:
        "You extract structured data from a photo or scan of a receipt or invoice. You never guess a " +
        "value that is not visible on the document — use null for anything you cannot read. You never " +
        "invent line items. You only ever call the extract_receipt tool with the fields it defines. Be " +
        "conservative with confidence: if the image is blurry, cropped, or ambiguous, use a lower score.",
      messages: [
        {
          role: "user",
          content: [
            documentBlock,
            { type: "text", text: "Extract this receipt/invoice's structured data." },
          ],
        },
      ],
      tools: [
        {
          name: EXTRACT_TOOL_NAME,
          description: "Report the structured fields extracted from the receipt/invoice.",
          input_schema: {
            type: "object",
            properties: {
              supplierName: { type: ["string", "null"] },
              date: { type: ["string", "null"], description: "YYYY-MM-DD, or null if not legible." },
              subtotal: { type: ["string", "null"] },
              taxAmount: { type: ["string", "null"] },
              total: { type: ["string", "null"] },
              currency: { type: ["string", "null"], description: "ISO 4217, e.g. AUD." },
              lineItems: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    amount: { type: "string" },
                  },
                  required: ["description", "amount"],
                },
              },
              suggestedCategory: { type: ["string", "null"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string" },
            },
            required: [
              "supplierName",
              "date",
              "subtotal",
              "taxAmount",
              "total",
              "currency",
              "lineItems",
              "suggestedCategory",
              "confidence",
              "reasoning",
            ],
          },
        },
      ],
      tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
    });

    const toolUse = message.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("AI response did not include an extract_receipt tool call.");
    }

    const parsed = ReceiptExtractionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(`AI response failed schema validation: ${parsed.error.message}`);
    }

    return { ...parsed.data, model: this.model };
  }
}

/**
 * Composes the AI extractor with a mandatory, silent fallback: a missing
 * API key, an unsupported file type, a network failure, a timeout, or a
 * schema validation failure all return `null` rather than throwing — the
 * upload still succeeds and the user gets a blank draft to fill in
 * manually, per master spec §17. Never surfaces the raw error to the user.
 */
export async function extractReceiptData(input: {
  mimeType: string;
  base64Data: string;
}): Promise<ReceiptExtraction | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const extractor = new AiReceiptExtractor(apiKey);
    return await extractor.extract(input);
  } catch {
    return null;
  }
}
