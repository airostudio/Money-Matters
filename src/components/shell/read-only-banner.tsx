import { Eye } from "lucide-react";
import { isReadOnlyRole, ROLE_LABELS } from "@/domain/permissions/role-info";
import type { MembershipRole } from "@/domain/permissions/roles";

/**
 * A persistent, unobtrusive notice for a member whose role holds no write
 * permission at all. Whether a role is "effectively read-only" is derived from
 * the permission matrix (`isReadOnlyRole`), never from `role === "READ_ONLY"`.
 * Renders nothing for anyone who can change something. Presentation only.
 */
export function ReadOnlyBanner({ role, orgName }: { role: MembershipRole; orgName: string }) {
  if (!isReadOnlyRole(role)) return null;
  return (
    <div
      role="status"
      data-testid="read-only-banner"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground"
    >
      <Eye className="size-3.5 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-medium text-foreground">Read-only access</span> to {orgName} ({ROLE_LABELS[role]} role).
        You can look at everything you&apos;re shown, but nothing you do here can change the books. To get edit access,
        ask the company owner.
      </p>
    </div>
  );
}
