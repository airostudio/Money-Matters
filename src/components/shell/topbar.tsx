import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import type { MembershipRole } from "@/domain/permissions/roles";

export function Topbar({
  orgSlug,
  orgName,
  role,
  userName,
  userEmail,
}: {
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
  userName: string;
  userEmail: string;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <MobileNav orgSlug={orgSlug} orgName={orgName} role={role} />
      </div>
      <div className="flex items-center gap-3">
        <Button asChild size="sm" variant="outline">
          <Link href={`/${orgSlug}/accounting/journals/new`}>
            <Plus /> New journal entry
          </Link>
        </Button>
        <UserMenu name={userName} email={userEmail} />
      </div>
    </header>
  );
}
