import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { DashboardShell } from "@/components/shell/dashboard-shell";

/**
 * Matches what `slugify()` produces (src/lib/utils.ts). Checked before any
 * auth or database work because this route sits at the URL root: a browser's
 * unsolicited `/favicon.ico` probe, or any stray top-level path, otherwise
 * lands here and does a full session lookup just to 404 — and reports the
 * session layer's own failures as a confusing 500 on a path that was never
 * an organization to begin with.
 */
const ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { orgSlug: string };
}) {
  if (!ORG_SLUG_PATTERN.test(params.orgSlug)) notFound();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const org = await OrganizationService.getBySlug(params.orgSlug);
  if (!org) notFound();

  const membership = await OrganizationService.getMembership(user.id, org.id);
  if (!membership) notFound();

  return (
    <DashboardShell
      orgSlug={org.slug}
      orgName={org.name}
      role={membership.role}
      userName={user.name}
      userEmail={user.email}
    >
      {children}
    </DashboardShell>
  );
}
