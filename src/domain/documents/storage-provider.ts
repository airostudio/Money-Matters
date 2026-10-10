import "server-only";
import { eq, and } from "drizzle-orm";
import { uploadedReceipts, workpaperEvidence } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import type { UserScopeDb } from "@/db/user-scope";

/**
 * Where an uploaded document's bytes actually live. `PostgresDocumentStorageProvider`
 * (bytea in the `uploaded_receipts` table, inside the same tenant-scoped
 * transaction as everything else — see `src/db/tenant.ts`) is the only
 * implementation today — a deliberate, temporary decision documented in
 * docs/decisions/0007-document-storage-bytea.md, made the same way Phase
 * 2's `BankFeedProvider` abstraction was: ship the usable, credential-free
 * path first, and make a real object-storage provider (S3, Vercel Blob) an
 * additive swap behind this interface later, not a rework of every caller.
 */
export interface StoredDocument {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface DocumentStorageProvider {
  store(
    tx: TenantDb,
    organizationId: string,
    input: { uploadedById: string; fileName: string; mimeType: string; data: Buffer },
  ): Promise<StoredDocument>;
  retrieve(
    tx: TenantDb,
    organizationId: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null>;
}

export const PostgresDocumentStorageProvider: DocumentStorageProvider = {
  async store(tx, organizationId, input) {
    const [row] = await tx
      .insert(uploadedReceipts)
      .values({
        organizationId,
        uploadedById: input.uploadedById,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: input.data.byteLength,
        fileData: input.data,
      })
      .returning({ id: uploadedReceipts.id, fileName: uploadedReceipts.fileName, mimeType: uploadedReceipts.mimeType, fileSize: uploadedReceipts.fileSize });
    if (!row) throw new Error("Failed to store uploaded document.");
    return row;
  },

  async retrieve(tx, organizationId, id) {
    const [row] = await tx
      .select({ data: uploadedReceipts.fileData, mimeType: uploadedReceipts.mimeType, fileName: uploadedReceipts.fileName })
      .from(uploadedReceipts)
      .where(and(eq(uploadedReceipts.id, id), eq(uploadedReceipts.organizationId, organizationId)));
    return row ?? null;
  },
};

/**
 * The same bytea store, for a PRACTICE-owned scope. Workpaper evidence belongs to the
 * accounting practice, not to any client organization: it must not sit in the client's
 * tenant table (the client could see it, and it would be lost or exposed if the client
 * left), so it is stored in `workpaper_evidence` — a practice-scoped table reached through
 * `withUserScope` (RLS keyed on practice membership). The abstraction and the validation
 * (document-validation.ts) are the same as the receipt store's, so a future object-storage
 * provider is the same additive swap for both (docs/decisions/0007-document-storage-bytea.md).
 */
export interface PracticeEvidenceStorageProvider {
  store(
    tx: UserScopeDb,
    practiceId: string,
    input: { workpaperId: string; uploadedById: string; fileName: string; mimeType: string; data: Buffer; description: string | null },
  ): Promise<StoredDocument>;
  retrieve(
    tx: UserScopeDb,
    practiceId: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null>;
}

export const PostgresPracticeEvidenceStorageProvider: PracticeEvidenceStorageProvider = {
  async store(tx, practiceId, input) {
    const [row] = await tx
      .insert(workpaperEvidence)
      .values({
        practiceId,
        workpaperId: input.workpaperId,
        uploadedByUserId: input.uploadedById,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: input.data.byteLength,
        fileData: input.data,
        description: input.description,
      })
      .returning({ id: workpaperEvidence.id, fileName: workpaperEvidence.fileName, mimeType: workpaperEvidence.mimeType, fileSize: workpaperEvidence.fileSize });
    if (!row) throw new Error("Failed to store workpaper evidence.");
    return row;
  },

  async retrieve(tx, practiceId, id) {
    const [row] = await tx
      .select({ data: workpaperEvidence.fileData, mimeType: workpaperEvidence.mimeType, fileName: workpaperEvidence.fileName })
      .from(workpaperEvidence)
      .where(and(eq(workpaperEvidence.id, id), eq(workpaperEvidence.practiceId, practiceId)));
    return row ?? null;
  },
};
