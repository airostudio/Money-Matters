"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { NAV_ITEMS } from "./nav-config";

export function NavLinks({
  orgSlug,
  role,
  onNavigate,
}: {
  orgSlug: string;
  role: MembershipRole;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const basePath = `/${orgSlug}`;

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV_ITEMS.filter((item) => !item.permission || roleHasPermission(role, item.permission)).map(
        (item) => {
          const href = `${basePath}${item.href}`;
          const isActive = item.href === "" ? pathname === basePath : pathname.startsWith(href);
          const visibleChildren = item.children?.filter(
            (child) => !child.permission || roleHasPermission(role, child.permission),
          );

          return (
            <div key={item.label}>
              <Link
                href={href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </Link>
              {isActive && visibleChildren && visibleChildren.length > 0 && (
                <div className="ml-6 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-3">
                  {visibleChildren.map((child) => {
                    const childHref = `${basePath}${child.href}`;
                    const childActive = pathname === childHref;
                    return (
                      <Link
                        key={child.href}
                        href={childHref}
                        onClick={onNavigate}
                        className={cn(
                          "rounded-md px-3 py-1.5 text-sm transition-colors",
                          childActive
                            ? "font-medium text-primary"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        },
      )}
    </nav>
  );
}
