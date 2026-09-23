# 0007 — Uploaded document storage: bytea in Postgres first, object storage behind an interface later

## Status
Accepted for Phase 2 Slice 2 (expense management, Document AI receipt
capture). Real object storage is a follow-up, not yet built.

## Context
Document AI receipt/invoice capture (master spec §17) needs somewhere to
keep the original uploaded file — a photo or PDF a human can always go back
to, independent of whatever Document AI extracted from it. The natural
production answer is an object storage service (S3, Vercel Blob, Supabase
Storage) with signed URLs. None of those have credentials available in this
environment — the same constraint that shaped
`docs/decisions/0006-bank-feed-abstraction.md`'s live bank feed provider
and, before that, the Supabase database credential handling in
`docs/security.md`: this codebase never invents a placeholder credential or
points at a vendor account it doesn't have.

Master spec §82 also asks for vertical slices, not superficial features. A
`DocumentStorageProvider` interface with nothing real behind it would be
untestable and effectively unusable until real credentials exist.

## Decision
Store the uploaded file's bytes directly in Postgres, as `bytea`, on the
`uploaded_receipts` table (`fileData` column, via a small Drizzle
`customType`) — inside the same tenant-scoped transaction and Row-Level
Security policy as every other row, so it inherits tenant isolation for
free rather than needing its own access-control layer.

This sits behind `DocumentStorageProvider`
(`src/domain/documents/storage-provider.ts`), a two-method interface
(`store`, `retrieve`) with exactly one implementation today,
`PostgresDocumentStorageProvider`. Every caller (`ReceiptService`) goes
through the interface, never the `uploaded_receipts` table directly for
file bytes — the same discipline `BankFeedProvider` established for bank
feeds: a real object-storage provider is a second implementation of this
same interface plus a data migration to move existing rows' bytes out,
not a rework of `ReceiptService` or anything that calls it.

Deliberate limits that keep this safe as a temporary measure:
- A hard 10MB upload limit (`MAX_RECEIPT_FILE_SIZE_BYTES`), enforced before
  the bytes ever reach storage or the AI call — bytea rows are fine at this
  size but this is not a design meant to scale to large files or high
  volume.
- A server-side MIME type allowlist (JPEG/PNG/WebP/GIF/PDF) — never trusts
  the browser-supplied `Content-Type` alone for anything beyond a
  first-pass check, but does not do deep file-format sniffing either; this
  is acceptable for a receipt-capture feature behind authentication, not
  for a public upload surface.
- No thumbnailing, streaming, or range-request support — a `retrieve` call
  returns the whole file in memory. Fine for a receipt/invoice; would not be
  fine for large PDFs or video.

## Why not defer the feature entirely instead
Document AI receipt capture is explicitly in this slice's scope, and it is
a genuinely standalone, testable feature without needing external storage
credentials — unlike a live bank feed or Stripe, storage is infrastructure
this codebase can provide itself (a database it already has) rather than a
vendor relationship someone has to set up. Deferring the whole feature over
this one implementation detail would be over-deferring; deferring only the
storage backend, behind an interface, is the more honest scope cut.

## Migration path
When real object storage credentials exist:
1. Implement a second `DocumentStorageProvider` (e.g.
   `S3DocumentStorageProvider`) that uploads to the bucket and returns a
   reference (key/URL) instead of writing `bytea`.
2. Add a nullable `storageRef` column (or similar) to `uploaded_receipts`
   alongside the existing `fileData`, migrate existing rows by re-uploading
   their bytes and populating `storageRef`, then drop `fileData` once
   every row has been migrated.
3. Swap which provider `ReceiptService` is constructed with — no change to
   `ExpenseClaimService`, the upload/extraction flow, or any UI, since they
   only ever see `StoredDocument` (id/fileName/mimeType/fileSize), never the
   storage mechanism.

## Alternatives considered
- **A generic `documents` table with a `storageRef` column pointing nowhere
  real yet.** Rejected: an untestable placeholder is worse than a working,
  if temporary, real implementation — the same reasoning
  `docs/decisions/0006-bank-feed-abstraction.md` used to reject a
  live-provider interface with no real vendor behind it.
- **Skip file storage entirely; keep only the AI-extracted structured
  data.** Rejected: master spec §17 assumes a human can go back to the
  original document (e.g. to check a figure the AI got wrong), and losing
  the source image the moment it's uploaded would make every extraction
  unverifiable after the fact.
