import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { isPlatformAdminUser } from "@/lib/platform-admin";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { ArchivedCompanyNotice } from "@/components/shell/archived-company";
import { restoreCompanyAction } from "@/app/app/actions";
import { getUiMode } from "@/lib/ui-mode";

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

  // The membership AND the archived flag in one query. A non-member gets a plain 404 whether or not the company is
  // archived (nothing is revealed). A MEMBER of an archived company gets an explicit "this company is archived" page -
  // they already know it exists, so a clear explanation (and, for an OWNER, the way back) beats a confusing 404 - and
  // `children` is deliberately NOT rendered, so no page under it runs. Server actions and route handlers fired at an
  // archived company are refused separately by the session helpers (src/lib/session.ts).
  const found = await OrganizationService.getMembershipWithState(user.id, org.id);
  if (!found) notFound();

  if (org.archivedAt) {
    const isOwner = found.membership.role === "OWNER";
    return (
      <ArchivedCompanyNotice
        orgId={org.id}
        orgName={org.name}
        archivedAt={org.archivedAt}
        reason={isOwner ? org.archiveReason : null}
        canRestore={isOwner}
        restoreAction={restoreCompanyAction}
      />
    );
  }
  const membership = found.membership;

  // One membership query feeds the company switcher (no per-organization lookups); archived companies are excluded.
  const memberships = await OrganizationService.listMembershipsForUser(user.id);
  const switcherOrgs = memberships
    .map((m) => ({ slug: m.organization.slug, name: m.organization.name, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <DashboardShell
      orgSlug={org.slug}
      switcherOrgs={switcherOrgs}
      orgName={org.name}
      role={membership.role}
      userName={user.name}
      userEmail={user.email}
      showAdminLink={isPlatformAdminUser(user)}
      mode={getUiMode()}
    >
      {children}
    </DashboardShell>
  );
}
