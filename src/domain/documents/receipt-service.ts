import "server-only";
import { and, eq } from "drizzle-orm";
import { uploadedReceipts } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostgresDocumentStorageProvider } from "./storage-provider";
import { extractReceiptData, type ReceiptExtraction } from "./receipt-extraction-service";

/** Reject anything larger than this before it ever reaches storage or the AI call. */
export const MAX_RECEIPT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_RECEIPT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export class UnsupportedReceiptFileTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported file type "${mimeType}" — upload a JPEG/PNG/WebP/GIF image or a PDF.`);
    this.name = "UnsupportedReceiptFileTypeError";
  }
}

export class ReceiptFileTooLargeError extends Error {
  constructor(size: number) {
    super(`File is ${(size / 1024 / 1024).toFixed(1)}MB — the maximum is 10MB.`);
    this.name = "ReceiptFileTooLargeError";
  }
}

export class ReceiptNotFoundError extends Error {
  constructor(id: string) {
    super(`Receipt ${id} was not found in this organization.`);
    this.name = "ReceiptNotFoundError";
  }
}

export interface UploadReceiptResult {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /** null when AI extraction was skipped (no API key), failed, or produced an invalid response — never an error to the caller. */
  extraction: ReceiptExtraction | null;
}

export const ReceiptService = {
  /**
   * Stores an uploaded receipt/invoice and — best-effort, never blocking —
   * runs Document AI extraction over it. The result always lands as a
   * *suggestion*: `extraction` here is never written onto an expense claim
   * or bill by this method. It's the caller's job (the expense-claim/bill
   * creation form) to show it as a pre-filled, fully editable draft that a
   * human must still confirm.
   */
  async upload(
    actor: Actor,
    input: { fileName: string; mimeType: string; data: Buffer },
  ): Promise<UploadReceiptResult> {
    assertPermission(actor, "expense_receipt:manage");

    if (!SUPPORTED_RECEIPT_MIME_TYPES.has(input.mimeType)) {
      throw new UnsupportedReceiptFileTypeError(input.mimeType);
    }
    if (input.data.byteLength === 0) {
      throw new Error("Uploaded file is empty.");
    }
    if (input.data.byteLength > MAX_RECEIPT_FILE_SIZE_BYTES) {
      throw new ReceiptFileTooLargeError(input.data.byteLength);
    }

    const extraction = await extractReceiptData({
      mimeType: input.mimeType,
      base64Data: input.data.toString("base64"),
    });

    return withTenant(actor.organizationId, async (tx) => {
      const stored = await PostgresDocumentStorageProvider.store(tx, actor.organizationId, {
        uploadedById: actor.userId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        data: input.data,
      });

      await tx
        .update(uploadedReceipts)
        .set({
          extractionStatus: extraction ? "EXTRACTED" : "FAILED",
          extractedData: extraction ?? null,
          extractionModel: extraction?.model ?? null,
          extractionConfidence: extraction ? extraction.confidence.toFixed(3) : null,
        })
        .where(eq(uploadedReceipts.id, stored.id));

      await AuditService.record(tx, actor, {
        action: "expense_receipt.uploaded",
        entityType: "UploadedReceipt",
        entityId: stored.id,
        after: { fileName: stored.fileName, mimeType: stored.mimeType, fileSize: stored.fileSize },
        metadata: extraction
          ? { source: "AI", model: extraction.model, confidence: extraction.confidence, reasoning: extraction.reasoning }
          : { source: "NONE" },
      });

      return { ...stored, extraction };
    });
  },

  async get(actor: Actor, receiptId: string) {
    assertPermission(actor, "expense_receipt:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          id: uploadedReceipts.id,
          fileName: uploadedReceipts.fileName,
          mimeType: uploadedReceipts.mimeType,
          fileSize: uploadedReceipts.fileSize,
          extractionStatus: uploadedReceipts.extractionStatus,
          extractedData: uploadedReceipts.extractedData,
          extractionModel: uploadedReceipts.extractionModel,
          extractionConfidence: uploadedReceipts.extractionConfidence,
          createdAt: uploadedReceipts.createdAt,
        })
        .from(uploadedReceipts)
        .where(and(eq(uploadedReceipts.id, receiptId), eq(uploadedReceipts.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },
};
