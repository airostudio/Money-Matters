"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import type { MembershipRole } from "@/domain/permissions/roles";
import { SEARCH_KIND_SPECS } from "@/domain/search/entities";
import { MIN_QUERY_LENGTH } from "@/domain/search/query";
import type { SearchGroup, SearchResponse } from "@/domain/search/types";
import {
  askAiItem,
  buildPaletteItems,
  filterPaletteItems,
  isPaletteShortcut,
  parseRecents,
  pushRecent,
  recentItems,
  recentStorageKey,
  type PaletteItem,
  type RecentEntry,
} from "./palette-model";
import {
  PaletteBody,
  optionIdFor,
  type PaletteOption,
  type PaletteSection,
  type PaletteStatus,
} from "./palette-body";
import type { UiMode } from "./ui-mode";

/**
 * The global search / command palette (master spec s.56, s.80): Cmd/Ctrl+K or the Search button in the top bar.
 *
 * What it does and does not do:
 *  - Commands and pages are filtered LOCALLY from the role's own menu data (palette-model.ts): no request.
 *  - Records (customers, invoices, ...) come from `GET /api/search`, fired only after the person has typed at least
 *    two characters and paused for DEBOUNCE_MS; a newer keystroke cancels the request still in flight (AbortController).
 *    Nothing is fetched when the palette opens, and nothing on page load.
 *  - Choosing a row only NAVIGATES (router.push). The palette performs no mutation and contains no AI call: the last
 *    row hands the question to the AI Financial Controller page, prefilled but not sent.
 *  - Recent items live in this browser's localStorage only (try/catch everywhere; the palette works without it).
 *
 * Accessibility: a Radix Dialog (role="dialog", aria-modal, focus trapped, Escape closes, focus returns to the
 * trigger) wrapping the ARIA combobox pattern rendered by PaletteBody.
 */

const DEBOUNCE_MS = 250;
const MAX_LOCAL_COMMANDS = 5;
const MAX_LOCAL_PAGES = 6;

function isSafePath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function toOption(item: PaletteItem): PaletteOption {
  return {
    id: item.id,
    label: item.label,
    hint: item.hint,
    href: item.href,
    remember: { permissions: item.permissions },
  };
}

export function CommandPalette({
  orgSlug,
  role,
  mode = "BUSINESS",
  userEmail,
}: {
  orgSlug: string;
  role: MembershipRole;
  mode?: UiMode;
  userEmail: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PaletteStatus>("idle");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [isMac, setIsMac] = useState(false);
  const cache = useRef(new Map<string, SearchGroup[]>());
  const storageKey = recentStorageKey(orgSlug, userEmail);

  const allItems = useMemo(() => buildPaletteItems(orgSlug, role, mode), [orgSlug, role, mode]);

  // Cmd/Ctrl+K from anywhere (including inside a text field).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || ""));
    function onKeyDown(e: KeyboardEvent) {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setOpen((current) => !current);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Opening loads this person's recents; closing, by any route (Escape, outside click, Cmd/Ctrl+K, choosing a row),
  // clears the query and results so the next open starts clean (the in-flight request is aborted by the effect below).
  useEffect(() => {
    if (open) {
      try {
        setRecents(parseRecents(window.localStorage.getItem(storageKey)));
      } catch {
        setRecents([]);
      }
    } else {
      setQuery("");
      setGroups([]);
      setStatus("idle");
      setActive(0);
      cache.current.clear();
    }
  }, [open, storageKey]);

  // Records: debounced, cancellable, minimum two characters. Everything is torn down when the query changes again.
  const trimmed = query.trim();
  useEffect(() => {
    if (!open) return;
    if (Array.from(trimmed).length < MIN_QUERY_LENGTH) {
      setGroups([]);
      setStatus("idle");
      return;
    }
    const cached = cache.current.get(trimmed);
    if (cached) {
      setGroups(cached);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const url = `/api/search?org=${encodeURIComponent(orgSlug)}&q=${encodeURIComponent(trimmed)}`;
        const res = await fetch(url, {
          signal: controller.signal,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (res.status === 401) {
          setGroups([]);
          setStatus("signed-out");
          return;
        }
        if (!res.ok) {
          setGroups([]);
          setStatus("error");
          return;
        }
        const body = (await res.json()) as SearchResponse;
        const safe = body.groups
          .map((g) => ({ ...g, items: g.items.filter((i) => isSafePath(i.href)) }))
          .filter((g) => g.items.length > 0);
        cache.current.set(trimmed, safe);
        setGroups(safe);
        setStatus("ready");
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return; // superseded by a newer keystroke
        setGroups([]);
        setStatus("error");
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, open, orgSlug]);

  const sections: PaletteSection[] = useMemo(() => {
    const out: PaletteSection[] = [];
    const commandItems = allItems.filter((i) => i.group === "Create" || i.group === "Find");
    if (trimmed === "") {
      const recent = recentItems(recents, role, orgSlug);
      if (recent.length > 0) out.push({ id: "recent", heading: "Recent", options: recent.map(toOption) });
      if (commandItems.length > 0) out.push({ id: "commands", heading: "Commands", options: commandItems.slice(0, 10).map(toOption) });
      return out;
    }
    const commands = filterPaletteItems(commandItems, trimmed, MAX_LOCAL_COMMANDS);
    if (commands.length > 0) out.push({ id: "commands", heading: "Commands", options: commands.map(toOption) });
    const pages = filterPaletteItems(
      allItems.filter((i) => i.group === "Go to"),
      trimmed,
      MAX_LOCAL_PAGES,
    );
    if (pages.length > 0) out.push({ id: "pages", heading: "Pages and reports", options: pages.map(toOption) });
    for (const g of groups) {
      out.push({
        id: `records-${g.kind}`,
        heading: g.label,
        options: g.items.map((i) => ({
          id: `result:${i.kind}:${i.id}`,
          label: i.title,
          hint: i.subtitle || undefined,
          href: i.href,
          remember: { permissions: SEARCH_KIND_SPECS[i.kind].permissions },
        })),
      });
    }
    const ask = askAiItem(orgSlug, role, trimmed);
    if (ask) out.push({ id: "ask", heading: "Ask", options: [{ id: ask.id, label: ask.label, href: ask.href }] });
    return out;
  }, [trimmed, allItems, groups, recents, role, orgSlug]);

  const flat = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const flatKey = flat.map((o) => o.id).join("|");

  // A new list starts at its first row; the highlighted row is kept in view.
  useEffect(() => {
    setActive(0);
  }, [flatKey]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionIdFor(uid, active))?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, flatKey, uid]);

  function choose(option: PaletteOption) {
    if (option.remember) {
      const entry: RecentEntry = { label: option.label, hint: option.hint, href: option.href, permissions: option.remember.permissions };
      const next = pushRecent(recents, entry);
      setRecents(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private window, blocked site data): recents just are not remembered.
      }
    }
    setOpen(false);
    router.push(option.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      const option = flat[active];
      if (option) {
        e.preventDefault();
        choose(option);
      }
    }
  }

  const announcement =
    status === "loading"
      ? "Searching"
      : status === "signed-out"
        ? "Your session has expired. Sign in again to search."
        : status === "error"
          ? "Search is unavailable right now. Commands and pages still work."
          : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Search"
          aria-keyshortcuts="Control+K Meta+K"
          data-testid="palette-trigger"
          className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background sm:px-3"
        >
          <Search className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border px-1 font-sans text-[10px] sm:inline" aria-hidden="true">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby={`${uid}-desc`}
          data-testid="palette-dialog"
          className="fixed left-1/2 top-[8vh] z-50 flex max-h-[80vh] w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <Dialog.Description id={`${uid}-desc`} className="sr-only">
            Type to search customers, suppliers, invoices, bills and more, or to run a command. Use the up and down arrow
            keys to move between results and Enter to open one. Escape closes.
          </Dialog.Description>
          <PaletteBody
            uid={uid}
            query={query}
            onQueryChange={setQuery}
            onKeyDown={onKeyDown}
            sections={sections}
            active={active}
            onActivate={setActive}
            onChoose={choose}
            status={status}
            announcement={announcement}
            isMac={isMac}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
