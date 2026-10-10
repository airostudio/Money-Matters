import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiChartOfAccountsRecommender,
  DeterministicRecommender,
  RecommendationSchema,
  recommendChartOfAccounts,
} from "@/domain/onboarding/chart-of-accounts-recommender";

describe("DeterministicRecommender", () => {
  const recommender = new DeterministicRecommender();

  it("classifies an electrical contracting business as TRADES", async () => {
    const result = await recommender.recommend({
      description: "We're an electrical contracting company in Melbourne with 5 employees",
      country: "AU",
    });
    expect(result.templateKey).toBe("TRADES");
    expect(result.flags.hasEmployees).toBe(true);
    expect(result.source).toBe("DETERMINISTIC");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies a retail shop as RETAIL and infers goods + inventory", async () => {
    const result = await recommender.recommend({
      description: "We run an online store selling handmade candles, no staff yet",
      country: "AU",
    });
    expect(result.templateKey).toBe("RETAIL");
    expect(result.flags.sellsGoods).toBe(true);
    expect(result.flags.tracksInventory).toBe(true);
  });

  it("classifies a cafe as HOSPITALITY", async () => {
    const result = await recommender.recommend({ description: "A small cafe serving coffee and lunch", country: "AU" });
    expect(result.templateKey).toBe("HOSPITALITY");
  });

  it("classifies a consulting firm as PROFESSIONAL_SERVICES", async () => {
    const result = await recommender.recommend({
      description: "A management consulting firm advising other businesses",
      country: "AU",
    });
    expect(result.templateKey).toBe("PROFESSIONAL_SERVICES");
  });

  it("falls back to GENERAL for an unrecognized description, with lower confidence", async () => {
    const result = await recommender.recommend({ description: "asdkfj qwer", country: "AU" });
    expect(result.templateKey).toBe("GENERAL");
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("never throws and never calls the network", async () => {
    await expect(recommender.recommend({ description: "", country: "AU" })).resolves.toBeDefined();
  });
});

describe("RecommendationSchema", () => {
  it("accepts a well-formed response", () => {
    const result = RecommendationSchema.safeParse({
      templateKey: "TRADES",
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: true,
      tracksInventory: false,
      confidence: 0.9,
      reasoning: "Electrical contracting business with employees.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown templateKey", () => {
    const result = RecommendationSchema.safeParse({
      templateKey: "MADE_UP_TEMPLATE",
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: false,
      tracksInventory: false,
      confidence: 0.5,
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    const result = RecommendationSchema.safeParse({
      templateKey: "GENERAL",
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: false,
      tracksInventory: false,
      confidence: 1.5,
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = RecommendationSchema.safeParse({ templateKey: "GENERAL" });
    expect(result.success).toBe(false);
  });
});

describe("AiChartOfAccountsRecommender", () => {
  it("throws when the model responds without a tool_use block, so the caller falls back", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "no tool call" }] }) };
      },
    }));
    const { AiChartOfAccountsRecommender: MockedRecommender } = await import(
      "@/domain/onboarding/chart-of-accounts-recommender"
    );
    const recommender = new MockedRecommender("fake-key");
    await expect(recommender.recommend({ description: "x", country: "AU" })).rejects.toThrow();
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("throws when the tool_use input fails schema validation", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                name: "classify_business",
                input: { templateKey: "NOT_REAL", confidence: 2 },
              },
            ],
          }),
        };
      },
    }));
    const { AiChartOfAccountsRecommender: MockedRecommender } = await import(
      "@/domain/onboarding/chart-of-accounts-recommender"
    );
    const recommender = new MockedRecommender("fake-key");
    await expect(recommender.recommend({ description: "x", country: "AU" })).rejects.toThrow(/schema/i);
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("returns a validated recommendation on a well-formed tool_use response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                name: "classify_business",
                input: {
                  templateKey: "TRADES",
                  sellsGoods: false,
                  sellsServices: true,
                  hasEmployees: true,
                  tracksInventory: false,
                  confidence: 0.92,
                  reasoning: "Electrical contracting business with employees, in Melbourne.",
                },
              },
            ],
          }),
        };
      },
    }));
    const { AiChartOfAccountsRecommender: MockedRecommender } = await import(
      "@/domain/onboarding/chart-of-accounts-recommender"
    );
    const recommender = new MockedRecommender("fake-key");
    const result = await recommender.recommend({
      description: "We're an electrical contracting company in Melbourne with 5 employees",
      country: "AU",
    });
    expect(result.templateKey).toBe("TRADES");
    expect(result.source).toBe("AI");
    expect(result.confidence).toBe(0.92);
    vi.doUnmock("@anthropic-ai/sdk");
  });
});

describe("recommendChartOfAccounts (composed AI + fallback)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("uses the deterministic classifier when no API key is set — no network call is attempted", async () => {
    const result = await recommendChartOfAccounts({
      description: "We're an electrical contracting company in Melbourne with 5 employees",
      country: "AU",
    });
    expect(result.source).toBe("DETERMINISTIC");
    expect(result.templateKey).toBe("TRADES");
  });

  it("falls back to the deterministic classifier when the AI call fails", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network unreachable")) };
      },
    }));

    const result = await recommendChartOfAccounts({
      description: "We're an electrical contracting company in Melbourne with 5 employees",
      country: "AU",
    });
    expect(result.source).toBe("DETERMINISTIC");
    expect(result.templateKey).toBe("TRADES");
  });
});
