import Link from "next/link";
import { BRAND_ICON } from "./nav-config";
import { NavLinks } from "./nav-links";
import type { MembershipRole } from "@/domain/permissions/roles";

export function Sidebar({
  orgSlug,
  orgName,
  role,
}: {
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
      <Link href="/app" className="flex items-center gap-2 border-b border-border px-4 py-4">
        <BRAND_ICON className="size-5 text-primary" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{orgName}</p>
          <p className="text-xs text-muted-foreground">Money Matters</p>
        </div>
      </Link>
      <div className="flex-1 overflow-y-auto py-3">
        <NavLinks orgSlug={orgSlug} role={role} />
      </div>
    </aside>
  );
}
