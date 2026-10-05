import { describeDenial } from "@/domain/permissions/role-info";

/**
 * The friendly stand-in for "your role may not do this" (master spec §79: an
 * error should explain its consequence). Used by the org-level error boundary
 * and the access-denied page. Presentation only — the refusal itself happens
 * in the domain services and is unchanged.
 */
export function PermissionDeniedView({
  permission,
  role,
  homeHref,
}: {
  permission: string;
  role: string;
  homeHref?: string;
}) {
  const { area, action, roleLabel } = describeDenial(permission, role);
  return (
    <div role="alert" data-testid="permission-denied" className="mx-auto max-w-xl space-y-3 rounded-lg border border-border bg-muted/40 p-6">
      <h1 className="text-lg font-semibold tracking-tight">
        {action === "view" ? "You don't have access to this page" : "You can't make changes here"}
      </h1>
      <p className="text-sm text-muted-foreground">
        You don&apos;t have access to {action} <span className="font-medium text-foreground">{area.toLowerCase()}</span>{" "}
        with your <span className="font-medium text-foreground">{roleLabel}</span> role.
        {action === "change" ? " Nothing was saved and the books are unchanged." : ""} If you need it, ask an owner or
        administrator of this company file to change your role.
      </p>
      {homeHref && (
        <a href={homeHref} className="inline-block text-sm text-primary underline">
          Back to the home page
        </a>
      )}
    </div>
  );
}
