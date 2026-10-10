/**
 * The ONE definition of what an uploaded document may be — shared by every place that
 * stores one in the bytea document store (docs/decisions/0007-document-storage-bytea.md):
 * expense receipts, a client's reply attachment to an accountant's request, and a
 * practice's workpaper evidence. Validation happens BEFORE anything reaches storage (or,
 * for receipts, the AI call).
 */

/** Reject anything larger than this. */
export const MAX_DOCUMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export class UnsupportedDocumentFileTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported file type "${mimeType}" — upload a JPEG/PNG/WebP/GIF image or a PDF.`);
    this.name = "UnsupportedReceiptFileTypeError";
  }
}

export class DocumentFileTooLargeError extends Error {
  constructor(size: number) {
    super(`File is ${(size / 1024 / 1024).toFixed(1)}MB — the maximum is 10MB.`);
    this.name = "ReceiptFileTooLargeError";
  }
}

export class EmptyDocumentError extends Error {
  constructor() {
    super("Uploaded file is empty.");
    this.name = "EmptyDocumentError";
  }
}

/** Throws unless `mimeType` is supported and `data` is non-empty and within the size cap. */
export function assertValidDocumentUpload(mimeType: string, data: Buffer): void {
  if (!SUPPORTED_DOCUMENT_MIME_TYPES.has(mimeType)) throw new UnsupportedDocumentFileTypeError(mimeType);
  if (data.byteLength === 0) throw new EmptyDocumentError();
  if (data.byteLength > MAX_DOCUMENT_FILE_SIZE_BYTES) throw new DocumentFileTooLargeError(data.byteLength);
}
