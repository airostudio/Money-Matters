import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";

/**
 * Renders its children only when `role` holds `permission`. The one shared way a
 * page hides a write control (primary "New ..." button, edit/post/void/approve
 * action) from a role that cannot use it. Presentation only: the domain service
 * the control calls still refuses an actor without the permission, so hiding is
 * a convenience and never the protection.
 */
export function Can({
  role,
  permission,
  children,
}: {
  role: MembershipRole;
  permission: Permission;
  children?: React.ReactNode;
}) {
  return roleHasPermission(role, permission) ? <>{children}</> : null;
}
