import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { EntitySwitcher, type SwitcherOrg } from "./entity-switcher";
import type { MembershipRole } from "@/domain/permissions/roles";
import { ModeToggle } from "./mode-toggle";
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
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <MobileNav orgSlug={orgSlug} orgName={orgName} role={role} mode={mode} />
        <EntitySwitcher currentSlug={orgSlug} orgs={switcherOrgs} />
      </div>
      <div className="flex items-center gap-3">
        <ModeToggle mode={mode} />
        <Button asChild size="sm" variant="outline">
          <Link href={`/${orgSlug}/accounting/journals/new`}>
            <Plus /> New journal entry
          </Link>
        </Button>
        <UserMenu name={userName} email={userEmail} showAdminLink={showAdminLink} />
      </div>
    </header>
  );
}
