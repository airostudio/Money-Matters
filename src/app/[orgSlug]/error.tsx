"use client";

import { useParams } from "next/navigation";
import { parsePermissionDeniedDigest } from "@/domain/permissions/permission-service";
import { isOrganizationArchivedDigest } from "@/domain/organizations/archived-digest";
import { PermissionDeniedView } from "@/components/shell/permission-denied";

/**
 * Org-level error boundary. Next.js hides an error's message in production, but
 * keeps a `digest` the error already carries; `PermissionDeniedError` encodes
 * the refused permission and role in its digest, so a role that is not allowed
 * to open a page (or run an action) gets a plain explanation instead of a
 * generic "Application error". Anything else is still reported as a failure.
 *
 * Presentation only: the refusal is still thrown by the domain service.
 */
export default function OrgError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ orgSlug?: string }>();
  const denial = parsePermissionDeniedDigest(error.digest);
  if (isOrganizationArchivedDigest(error.digest)) {
    // A server action (or page) fired at a company that was archived after the page loaded: say so plainly. The
    // [orgSlug] layout shows the full archived page with the restore button on the next navigation.
    return (
      <div role="status" className="mx-auto max-w-xl space-y-3 rounded-lg border border-border bg-card p-6">
        <h1 className="text-lg font-semibold tracking-tight">This company is archived</h1>
        <p className="text-sm text-muted-foreground">
          Nothing was changed. Nobody can view or change this company until an owner restores it.
        </p>
        <a href={params?.orgSlug ? `/${params.orgSlug}` : "/app"} className="text-sm text-primary underline">
          Continue
        </a>
      </div>
    );
  }
  if (denial) {
    return (
      <PermissionDeniedView
        permission={denial.permission}
        role={denial.role}
        homeHref={params?.orgSlug ? `/${params.orgSlug}` : undefined}
      />
    );
  }
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
      <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        That page could not be loaded.{error.digest ? ` Reference: ${error.digest}.` : ""}
      </p>
      <button type="button" onClick={reset} className="text-sm text-primary underline">
        Try again
      </button>
    </div>
  );
}
