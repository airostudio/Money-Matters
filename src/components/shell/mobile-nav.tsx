"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { BRAND_ICON } from "./nav-config";
import { NavLinks } from "./nav-links";
import type { MembershipRole } from "@/domain/permissions/roles";

export function MobileNav({
  orgSlug,
  orgName,
  role,
}: {
  orgSlug: string;
  orgName: string;
  role: MembershipRole;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open navigation"
          className="flex size-9 items-center justify-center rounded-md hover:bg-accent md:hidden"
        >
          <Menu className="size-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-card shadow-lg md:hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-4">
            <Dialog.Title asChild>
              <div className="flex items-center gap-2">
                <BRAND_ICON className="size-5 text-primary" />
                <span className="truncate text-sm font-semibold">{orgName}</span>
              </div>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close navigation"
                className="flex size-8 items-center justify-center rounded-md hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto py-3">
            <NavLinks orgSlug={orgSlug} role={role} onNavigate={() => setOpen(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
