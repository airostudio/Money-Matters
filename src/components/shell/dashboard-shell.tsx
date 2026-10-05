import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import type { MembershipRole } from "@/domain/permissions/roles";

export function DashboardShell({
  orgSlug,
  orgName,
  role,
  userName,
  userEmail,
  showAdminLink = false,
  children,
}: {
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
  userName: string;
  userEmail: string;
  /** Decided server-side in the [orgSlug] layout; false for everyone but platform admins. */
  showAdminLink?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar orgSlug={orgSlug} orgName={orgName} role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar orgSlug={orgSlug} orgName={orgName} role={role} userName={userName} userEmail={userEmail} showAdminLink={showAdminLink} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
