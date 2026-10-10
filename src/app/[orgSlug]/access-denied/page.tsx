import { requireOrgAndActor } from "@/lib/session";
import { PERMISSIONS } from "@/domain/permissions/roles";
import { PermissionDeniedView } from "@/components/shell/permission-denied";

/**
 * Where a refused server action lands (see src/lib/action-errors.ts). The role
 * shown is the viewer's real role from their membership, never a query value;
 * the permission is only used for wording and must be a known permission name.
 */
export default async function AccessDeniedPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { permission?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const requested = typeof searchParams.permission === "string" ? searchParams.permission : "";
  const permission = (PERMISSIONS as readonly string[]).includes(requested) ? requested : "organization:manage";
  return <PermissionDeniedView permission={permission} role={actor.role} homeHref={`/${org.slug}`} />;
}
