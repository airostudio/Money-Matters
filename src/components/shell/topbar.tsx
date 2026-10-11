import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { EntitySwitcher, type SwitcherOrg } from "./entity-switcher";
import type { MembershipRole } from "@/domain/permissions/roles";
import { ModeToggle } from "./mode-toggle";
import { CommandPalette } from "./command-palette";
import { CreateMenu } from "./create-menu";
import type { UiMode } from "./ui-mode";

export function Topbar({
  orgSlug,
  orgName,
  role,
  userName,
  userEmail,
  showAdminLink = false,
  switcherOrgs = [],
  mode = "BUSINESS",
}: {
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
  userName: string;
  userEmail: string;
  showAdminLink?: boolean;
  switcherOrgs?: SwitcherOrg[];
  mode?: UiMode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-4">
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav orgSlug={orgSlug} orgName={orgName} role={role} mode={mode} />
        <EntitySwitcher currentSlug={orgSlug} orgs={switcherOrgs} />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <ModeToggle mode={mode} />
        {/* Search and Create are client components fed only static, role-derived data: no query runs for either on a page view. */}
        <CommandPalette orgSlug={orgSlug} role={role} mode={mode} userEmail={userEmail} />
        <CreateMenu orgSlug={orgSlug} role={role} />
        <UserMenu name={userName} email={userEmail} showAdminLink={showAdminLink} />
      </div>
    </header>
  );
}
