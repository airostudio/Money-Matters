import { PermissionDeniedView } from "@/components/shell/permission-denied";
import { roleHasPermission, type Permission } from "@/domain/permissions/roles";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * For a page that exists only to write (a "New ..." form, a depreciation run):
 * returns the friendly "you can't make changes here" view when the actor's role
 * lacks `permission`, otherwise null so the page renders normally.
 *
 *   const denied = deniedViewUnless(actor, "customer_invoice:manage", org.slug);
 *   if (denied) return denied;
 *
 * Presentation only - the page's server action calls a domain service that
 * still refuses an actor without the permission, so this never replaces that
 * check; it just spares a read-only user a form that could only fail.
 */
export function deniedViewUnless(actor: Actor, permission: Permission, orgSlug: string): React.ReactElement | null {
  if (roleHasPermission(actor.role, permission)) return null;
  return <PermissionDeniedView permission={permission} role={actor.role} homeHref={`/${orgSlug}`} />;
}
