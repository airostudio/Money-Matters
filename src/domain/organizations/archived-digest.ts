/**
 * Client-safe (pure strings, no imports) half of "this company is archived" error handling.
 *
 * Next.js replaces the message of an error thrown while rendering a server component or running a server action
 * with a generic one in production, but preserves a `digest` the error already carries and hands it to the nearest
 * `error.tsx`. `OrganizationArchivedError` (archive-rules.ts) encodes itself in that digest so the org-level error
 * boundary can show the friendly "This company is archived" state instead of a 500. Presentation only: the refusal
 * is the throw itself.
 */
export const ORGANIZATION_ARCHIVED_DIGEST = "ORGANIZATION_ARCHIVED";

export function isOrganizationArchivedDigest(digest: string | undefined): boolean {
  return digest === ORGANIZATION_ARCHIVED_DIGEST;
}
