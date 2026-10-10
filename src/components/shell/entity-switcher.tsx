"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import Link from "next/link";
import { Building2, Check, ChevronsUpDown, KeyRound, Layers, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SwitcherOrg {
  slug: string;
  name: string;
  role: string;
}

/**
 * "Switch company instantly": a plain list of the user's own organizations,
 * rendered from the single membership query the [orgSlug] layout already makes —
 * no per-organization lookups. Each item is an ordinary link to that
 * organization's home page: nothing is carried across (the other organization
 * resolves the user's role there for itself), so switching never lends one
 * entity's permissions to another. Shown even for a single company (it also leads to creating or joining another).
 */
export function EntitySwitcher({ currentSlug, orgs }: { currentSlug: string; orgs: SwitcherOrg[] }) {
  const current = orgs.find((o) => o.slug === currentSlug);
  // Always shown now (even with one company): it is also where "Create a new company" and "Join a company" live.

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex max-w-[14rem] items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent"
          aria-label="Switch company"
        >
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{current?.name ?? "Switch company"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={cn("z-50 min-w-60 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md")}
        >
          <p className="px-3 py-1.5 text-xs font-medium uppercase text-muted-foreground">Your companies</p>
          {orgs.map((o) => (
            <DropdownMenu.Item key={o.slug} asChild>
              <Link
                href={`/${o.slug}`}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm outline-none hover:bg-accent"
              >
                <span className="truncate">{o.name}</span>
                {o.slug === currentSlug ? <Check className="size-4" /> : <span className="text-xs text-muted-foreground">{o.role.toLowerCase().replace("_", " ")}</span>}
              </Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link href="/app/new" className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none hover:bg-accent">
              <Plus className="size-4" /> Create a new company
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/app?all=1" className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none hover:bg-accent">
              <KeyRound className="size-4" /> Join a company / all companies
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/app/groups" className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none hover:bg-accent">
              <Layers className="size-4" /> Consolidated reporting
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
