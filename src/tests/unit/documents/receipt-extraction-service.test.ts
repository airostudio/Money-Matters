import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiReceiptExtractor,
  ReceiptExtractionSchema,
  extractReceiptData,
} from "@/domain/documents/receipt-extraction-service";

const VALID_INPUT = {
  supplierName: "Bunnings Trade",
  date: "2026-01-15",
  subtotal: "90.00",
  taxAmount: "9.00",
  total: "99.00",
  currency: "AUD",
  lineItems: [{ description: "Screws", amount: "99.00" }],
  suggestedCategory: "Materials",
  confidence: 0.85,
  reasoning: "Clear, well-lit receipt with all fields legible.",
};

describe("ReceiptExtractionSchema", () => {
  it("accepts a well-formed extraction", () => {
    expect(ReceiptExtractionSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it("accepts nulls for unreadable fields", () => {
    const result = ReceiptExtractionSchema.safeParse({ ...VALID_INPUT, supplierName: null, date: null });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(ReceiptExtractionSchema.safeParse({ ...VALID_INPUT, date: "15/01/2026" }).success).toBe(false);
  });

  it("rejects a non-decimal amount", () => {
    expect(ReceiptExtractionSchema.safeParse({ ...VALID_INPUT, total: "ninety-nine" }).success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    expect(ReceiptExtractionSchema.safeParse({ ...VALID_INPUT, confidence: 1.2 }).success).toBe(false);
  });

  it("rejects a line item missing amount", () => {
    expect(
      ReceiptExtractionSchema.safeParse({ ...VALID_INPUT, lineItems: [{ description: "x" }] }).success,
    ).toBe(false);
  });
});

describe("AiReceiptExtractor", () => {
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("rejects an unsupported mime type before ever calling the SDK", async () => {
    const extractor = new AiReceiptExtractor("fake-key");
    await expect(extractor.extract({ mimeType: "text/plain", base64Data: "eA==" })).rejects.toThrow(/Unsupported/);
  });

  it("throws when the model responds without a tool_use block, so the caller falls back", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "no tool call" }] }) };
      },
    }));
    const { AiReceiptExtractor: Mocked } = await import("@/domain/documents/receipt-extraction-service");
    const extractor = new Mocked("fake-key");
    await expect(extractor.extract({ mimeType: "image/jpeg", base64Data: "eA==" })).rejects.toThrow();
  });

  it("throws when the tool_use input fails schema validation", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", name: "extract_receipt", input: { confidence: 5 } }],
          }),
        };
      },
    }));
    const { AiReceiptExtractor: Mocked } = await import("@/domain/documents/receipt-extraction-service");
    const extractor = new Mocked("fake-key");
    await expect(extractor.extract({ mimeType: "image/jpeg", base64Data: "eA==" })).rejects.toThrow(/schema/i);
  });

  it("returns a validated extraction on a well-formed tool_use response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", name: "extract_receipt", input: VALID_INPUT }],
          }),
        };
      },
    }));
    const { AiReceiptExtractor: Mocked } = await import("@/domain/documents/receipt-extraction-service");
    const extractor = new Mocked("fake-key");
    const result = await extractor.extract({ mimeType: "image/png", base64Data: "eA==" });
    expect(result.supplierName).toBe("Bunnings Trade");
    expect(result.total).toBe("99.00");
    expect(result.model).toBeTruthy();
  });
});

describe("extractReceiptData (composed AI + fallback)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("returns null when no API key is set — no network call is attempted", async () => {
    const result = await extractReceiptData({ mimeType: "image/jpeg", base64Data: "eA==" });
    expect(result).toBeNull();
  });

  it("returns null (never throws) when the AI call fails", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network unreachable")) };
      },
    }));

    const result = await extractReceiptData({ mimeType: "image/jpeg", base64Data: "eA==" });
    expect(result).toBeNull();
  });

  it("returns null for an unsupported mime type rather than throwing", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key";
    const result = await extractReceiptData({ mimeType: "text/plain", base64Data: "eA==" });
    expect(result).toBeNull();
  });
});
