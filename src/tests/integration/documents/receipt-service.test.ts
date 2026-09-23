import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import {
  ReceiptFileTooLargeError,
  ReceiptService,
  UnsupportedReceiptFileTypeError,
} from "@/domain/documents/receipt-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("ReceiptService (document AI + storage) — integration", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  let owner: Actor;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("receipts");
    owner = org.owner;
  });

  it("stores an upload and returns a null extraction when no API key is set", async () => {
    const result = await ReceiptService.upload(owner, {
      fileName: "receipt.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("fake-image-bytes"),
    });
    expect(result.id).toBeTruthy();
    expect(result.fileSize).toBe(Buffer.byteLength("fake-image-bytes"));
    expect(result.extraction).toBeNull();

    const stored = await ReceiptService.get(owner, result.id);
    expect(stored!.extractionStatus).toBe("FAILED");
  });

  it("rejects an unsupported file type before ever touching storage", async () => {
    await expect(
      ReceiptService.upload(owner, { fileName: "notes.txt", mimeType: "text/plain", data: Buffer.from("x") }),
    ).rejects.toThrow(UnsupportedReceiptFileTypeError);
  });

  it("rejects a file over 10MB", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(
      ReceiptService.upload(owner, { fileName: "big.png", mimeType: "image/png", data: big }),
    ).rejects.toThrow(ReceiptFileTooLargeError);
  });

  it("stores extracted data and confidence when the AI call succeeds", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                name: "extract_receipt",
                input: {
                  supplierName: "Officeworks",
                  date: "2026-02-03",
                  subtotal: "45.00",
                  taxAmount: "4.50",
                  total: "49.50",
                  currency: "AUD",
                  lineItems: [{ description: "Paper", amount: "49.50" }],
                  suggestedCategory: "Office Supplies",
                  confidence: 0.88,
                  reasoning: "Clear photo, all fields legible.",
                },
              },
            ],
          }),
        };
      },
    }));

    const { ReceiptService: MockedService } = await import("@/domain/documents/receipt-service");
    const result = await MockedService.upload(owner, {
      fileName: "receipt.png",
      mimeType: "image/png",
      data: Buffer.from("fake-image-bytes"),
    });
    expect(result.extraction).not.toBeNull();
    expect(result.extraction!.supplierName).toBe("Officeworks");

    const stored = await MockedService.get(owner, result.id);
    expect(stored!.extractionStatus).toBe("EXTRACTED");
    expect(Number(stored!.extractionConfidence)).toBeCloseTo(0.88, 2);
  });

  it("a receipt uploaded under org A is invisible to org B", async () => {
    const orgB = await createTestOrg("receipts-b");
    const result = await ReceiptService.upload(owner, {
      fileName: "receipt.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("fake-image-bytes"),
    });

    expect(await ReceiptService.get(orgB.owner, result.id)).toBeNull();
  });
});
