import "server-only";
import { z } from "zod";
import { TEMPLATE_KEYS, type ClassificationFlags, type TemplateKey } from "./chart-of-accounts-templates";

/**
 * The result of classifying a business description into a chart-of-accounts
 * template + parameters. This is the ONLY thing the AI (or the deterministic
 * fallback) is allowed to produce — never an account code or name. See
 * docs/ai-agents.md's "classify, then deterministically expand" pattern.
 */
export interface Recommendation {
  templateKey: TemplateKey;
  flags: ClassificationFlags;
  confidence: number;
  reasoning: string;
  /** Which path produced this — shown (softened) in the UI so nothing about the AI call is hidden, master spec §6. */
  source: "AI" | "DETERMINISTIC";
  model?: string;
}

/** Strict schema every AI response is validated against before it is trusted at all. */
export const RecommendationSchema = z.object({
  templateKey: z.enum(TEMPLATE_KEYS),
  sellsGoods: z.boolean(),
  sellsServices: z.boolean(),
  hasEmployees: z.boolean(),
  tracksInventory: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export type RecommendationSchemaShape = z.infer<typeof RecommendationSchema>;

export interface RecommendInput {
  description: string;
  country: string;
  industry?: string;
}

/** Implemented by both the AI-backed recommender and the deterministic fallback. */
export interface ChartOfAccountsRecommender {
  recommend(input: RecommendInput): Promise<Recommendation>;
}

const KEYWORD_RULES: Array<{ templateKey: TemplateKey; keywords: RegExp }> = [
  {
    templateKey: "TRADES",
    keywords:
      /\b(trade|tradie|contract(?:ing|or)?|electric(?:al|ian)?|plumb(?:er|ing)?|build(?:er|ing)?|construction|carpentry|carpenter|roofing|hvac|landscap(?:er|ing)?|painter|painting)\b/i,
  },
  {
    templateKey: "RETAIL",
    keywords: /\b(retail|shop|store|e-?commerce|ecommerce|boutique|sell(?:ing)? products?|online store|marketplace)\b/i,
  },
  {
    templateKey: "HOSPITALITY",
    keywords: /\b(caf[eé]|cafe|restaurant|hospitality|catering|food truck|bar\b|pub\b|bakery|kitchen|dining)\b/i,
  },
  {
    templateKey: "PROFESSIONAL_SERVICES",
    keywords:
      /\b(consult(?:ing|ant)?|advisory|accounting|law firm|lawyer|legal|agency|marketing firm|design studio|freelance|professional services|bookkeep(?:ing|er)?)\b/i,
  },
];

const GOODS_KEYWORDS = /\b(sell(?:s|ing)?|retail|product|goods|inventory|stock|merchandise|shop)\b/i;
const SERVICES_KEYWORDS = /\b(service|consult|contract|repair|maintenance|advis|install)\b/i;
const EMPLOYEE_KEYWORDS = /\b(employ(?:ee|ees|s)?|staff|team of|hire|payroll)\b/i;
const INVENTORY_KEYWORDS = /\b(inventory|stock|warehouse|goods on hand|supplies inventory)\b/i;

/**
 * Deterministic keyword-based classifier. Requires no network access and no
 * API key — this is the mandatory fallback, and it is fully unit-testable.
 * It is intentionally simple: a small, auditable set of rules rather than
 * anything probabilistic, so its behavior is predictable and stable.
 */
export class DeterministicRecommender implements ChartOfAccountsRecommender {
  async recommend(input: RecommendInput): Promise<Recommendation> {
    const text = input.description.toLowerCase();

    let templateKey: TemplateKey = "GENERAL";
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.test(text)) {
        templateKey = rule.templateKey;
        break;
      }
    }

    const sellsGoods =
      GOODS_KEYWORDS.test(text) || templateKey === "RETAIL" || templateKey === "HOSPITALITY";
    const sellsServices =
      SERVICES_KEYWORDS.test(text) ||
      templateKey === "TRADES" ||
      templateKey === "PROFESSIONAL_SERVICES" ||
      (!sellsGoods && templateKey === "GENERAL");
    const hasEmployees = EMPLOYEE_KEYWORDS.test(text);
    const tracksInventory =
      INVENTORY_KEYWORDS.test(text) || templateKey === "RETAIL" || templateKey === "HOSPITALITY";

    const matchedTrades = templateKey !== "GENERAL";

    return {
      templateKey,
      flags: { sellsGoods, sellsServices, hasEmployees, tracksInventory },
      confidence: matchedTrades ? 0.6 : 0.35,
      reasoning: matchedTrades
        ? `Matched keywords in your description to the ${templateKey.replace(/_/g, " ").toLowerCase()} template using our standard keyword classifier.`
        : "Couldn't confidently match a specific industry from the description, so we're starting from the general-purpose template — you can add or remove accounts before anything is created.",
      source: "DETERMINISTIC",
    };
  }
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const CLASSIFY_TOOL_NAME = "classify_business";

/**
 * AI-backed classifier. Uses Claude's tool-use / structured-output feature
 * so the model's response is constrained to a JSON schema that maps 1:1
 * onto `RecommendationSchema` — the model never freely generates text that
 * is used directly. The response is re-validated in code regardless
 * (never trust a schema constraint alone); an invalid or unparseable
 * response is treated as a hard failure, letting the caller fall back to
 * `DeterministicRecommender` rather than guessing.
 */
export class AiChartOfAccountsRecommender implements ChartOfAccountsRecommender {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = process.env.ANTHROPIC_ONBOARDING_MODEL || DEFAULT_MODEL,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async recommend(input: RecommendInput): Promise<Recommendation> {
    // Lazy import so the SDK is never pulled in when no API key is configured.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey, timeout: this.timeoutMs });

    const templateList = TEMPLATE_KEYS.join(", ");

    const message = await client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system:
        "You classify small businesses into ONE of a fixed set of chart-of-accounts template keys, " +
        "and a small set of true/false attributes. You never invent account names, codes, or numbers " +
        "— you only ever call the classify_business tool with the fields it defines. Be conservative: " +
        "if uncertain, prefer GENERAL and a lower confidence score.",
      messages: [
        {
          role: "user",
          content:
            `Business description: ${input.description}\n` +
            `Country: ${input.country}\n` +
            (input.industry ? `Stated industry: ${input.industry}\n` : "") +
            `Available template keys: ${templateList}`,
        },
      ],
      tools: [
        {
          name: CLASSIFY_TOOL_NAME,
          description: "Classify the business into a chart-of-accounts template and attributes.",
          input_schema: {
            type: "object",
            properties: {
              templateKey: { type: "string", enum: [...TEMPLATE_KEYS] },
              sellsGoods: { type: "boolean" },
              sellsServices: { type: "boolean" },
              hasEmployees: { type: "boolean" },
              tracksInventory: { type: "boolean" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string" },
            },
            required: [
              "templateKey",
              "sellsGoods",
              "sellsServices",
              "hasEmployees",
              "tracksInventory",
              "confidence",
              "reasoning",
            ],
          },
        },
      ],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
    });

    const toolUse = message.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("AI response did not include a classify_business tool call.");
    }

    const parsed = RecommendationSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(`AI response failed schema validation: ${parsed.error.message}`);
    }

    const { templateKey, sellsGoods, sellsServices, hasEmployees, tracksInventory, confidence, reasoning } =
      parsed.data;

    return {
      templateKey,
      flags: { sellsGoods, sellsServices, hasEmployees, tracksInventory },
      confidence,
      reasoning,
      source: "AI",
      model: this.model,
    };
  }
}

/**
 * Composes the AI recommender with the mandatory deterministic fallback.
 * Never throws: any missing API key, network failure, timeout, or schema
 * validation failure silently (from the user's perspective — see the
 * caller's UI copy) falls back to the deterministic classifier so the
 * wizard always completes.
 */
export async function recommendChartOfAccounts(input: RecommendInput): Promise<Recommendation> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const ai = new AiChartOfAccountsRecommender(apiKey);
      return await ai.recommend(input);
    } catch {
      // Fall through to the deterministic classifier. Never surface the raw
      // error to the user — see docs/ai-agents.md and the UX guidance in
      // the onboarding wizard.
    }
  }
  return new DeterministicRecommender().recommend(input);
}
