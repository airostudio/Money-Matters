"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MembershipRole } from "@/domain/permissions/roles";
import { createGroupsFor } from "./nav-config";
import { isCreateShortcut } from "./palette-model";

/**
 * The universal "+ Create" menu (master spec s.57). Each entry links to the existing "New ..." page and is offered
 * only if the role holds every permission that page needs (nav-config.ts CREATE_ACTIONS); with nothing to offer the
 * whole control is absent. Radix provides the menu semantics: arrow keys, Home/End, type-ahead, Escape, focus return.
 *
 * Shortcut: a bare "C" opens the menu, but never while the person is typing in a field, with any modifier held, or
 * while another dialog or menu is open (see isCreateShortcut). It is announced via aria-keyshortcuts and listed in
 * the command palette's help row.
 */
export function CreateMenu({ orgSlug, role }: { orgSlug: string; role: MembershipRole }) {
  const groups = createGroupsFor(role);
  const [open, setOpen] = useState(false);
  const available = groups.length > 0;

  useEffect(() => {
    if (!available) return;
    function onKeyDown(e: KeyboardEvent) {
      const overlayOpen = Boolean(document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]'));
      if (!isCreateShortcut(e, overlayOpen)) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [available]);

  if (!available) return null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Create"
          aria-keyshortcuts="C"
          data-testid="create-menu-trigger"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background sm:px-3"
        >
          <Plus className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Create</span>
          <ChevronDown className="hidden size-3.5 opacity-70 sm:inline" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          aria-label="Create"
          className="z-50 max-h-[80vh] min-w-52 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {groups.map((g, index) => (
            <DropdownMenu.Group key={g.group}>
              {index > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
              <DropdownMenu.Label className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {g.group}
              </DropdownMenu.Label>
              {g.actions.map((action) => (
                <DropdownMenu.Item key={action.href} asChild>
                  <Link
                    href={`/${orgSlug}${action.href}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none",
                      "hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent",
                    )}
                  >
                    {action.label}
                  </Link>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            Press <kbd className="rounded border border-border px-1 font-sans">C</kbd> to open this menu
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
