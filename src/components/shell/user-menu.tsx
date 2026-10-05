"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { LogOut, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export function UserMenu({
  name,
  email,
  showAdminLink = false,
}: {
  name: string;
  email: string;
  showAdminLink?: boolean;
}) {
  const initial = (name || email || "?").charAt(0).toUpperCase();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground"
          aria-label="Account menu"
        >
          {initial}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className={cn(
            "z-50 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          )}
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {showAdminLink && (
            <DropdownMenu.Item asChild>
              <Link
                href="/admin"
                className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none hover:bg-accent"
              >
                <ShieldCheck className="size-4" /> Platform admin
              </Link>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive outline-none hover:bg-destructive/10"
            onSelect={() => signOut({ callbackUrl: "/login" })}
          >
            <LogOut className="size-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
