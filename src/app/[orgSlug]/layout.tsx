import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { DashboardShell } from "@/components/shell/dashboard-shell";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { orgSlug: string };
}) {
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
