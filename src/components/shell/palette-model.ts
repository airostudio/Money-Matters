import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import { PAGE_ALIASES, PAGE_PERMISSION_OVERRIDES, STATIC_COMMANDS } from "@/domain/search/commands";
import { CREATE_ACTIONS, NAV_ITEMS } from "./nav-config";
import { labelForMode, type UiMode } from "./ui-mode";

/**
 * The command palette's data model (master spec s.56 / s.80): which commands and pages a role is offered, how a typed
 * query filters them, and the per-user "recent" list. PURE: no React, no database, no service imports, so the
 * palette adds nothing to the page-render path and every rule here is unit-testable.
 *
 * Commands only NAVIGATE. There is no mutation anywhere in this file.
 */

export type PaletteGroup = "Create" | "Find" | "Go to" | "Recent" | "Ask";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text, e.g. the menu section a page sits under. */
  hint?: string;
  /** Absolute path, organization slug included. */
  href: string;
  /** Extra words the filter matches on. */
  keywords: string[];
  /** All must be held; kept so a stored recent can be re-checked against the role that is signed in NOW. */
  permissions: Permission[];
}

const holdsAll = (role: MembershipRole, permissions: Permission[]) => permissions.every((p) => roleHasPermission(role, p));

/** "New ..." commands: the Create menu's own entries, so the two cannot disagree about who may do what. */
function createCommands(orgSlug: string, role: MembershipRole): PaletteItem[] {
  return CREATE_ACTIONS.filter((a) => holdsAll(role, a.permissions)).map((a) => ({
    id: `create:${a.href}`,
    group: "Create" as const,
    label: a.commandLabel,
    hint: a.group,
    href: `/${orgSlug}${a.href}`,
    keywords: ["create", "add", "new", a.label.toLowerCase()],
    permissions: a.permissions,
  }));
}

function findCommands(orgSlug: string, role: MembershipRole): PaletteItem[] {
  return STATIC_COMMANDS.filter((c) => holdsAll(role, c.permissions)).map((c) => ({
    id: `command:${c.id}`,
    group: "Find" as const,
    label: c.label,
    href: `/${orgSlug}${c.href}`,
    keywords: c.keywords,
    permissions: c.permissions,
  }));
}

/** "Go to ..." for every navigation destination the role's menu shows, from the same data the sidebar renders. */
function pageCommands(orgSlug: string, role: MembershipRole, mode: UiMode): PaletteItem[] {
  const items: PaletteItem[] = [];
  const seen = new Set<string>();
  const push = (label: string, href: string, hint: string | undefined, perms: Permission[], absolute: boolean) => {
    const full = absolute ? href : `/${orgSlug}${href}`;
    if (seen.has(full)) return;
    seen.add(full);
    const override = PAGE_PERMISSION_OVERRIDES[href];
    const permissions = override ? [...new Set([...perms, ...override])] : perms;
    if (!holdsAll(role, permissions)) return;
    items.push({
      id: `page:${full}`,
      group: "Go to",
      label: `Go to ${label}`,
      hint,
      href: full || "/",
      keywords: [label.toLowerCase(), ...(hint ? [hint.toLowerCase()] : []), ...(PAGE_ALIASES[href] ?? [])],
      permissions,
    });
  };

  for (const item of NAV_ITEMS) {
    if (item.onlyInMode && item.onlyInMode !== mode) continue;
    if (item.permission && !roleHasPermission(role, item.permission)) continue;
    if (item.anyPermission && !item.anyPermission.some((p) => roleHasPermission(role, p))) continue;
    const label = labelForMode(item.label, mode);
    const own: Permission[] = item.permission ? [item.permission] : [];
    push(label, item.absoluteHref ?? item.href, undefined, own, Boolean(item.absoluteHref));
    for (const child of item.children ?? []) {
      push(labelForMode(child.label, mode), child.href, label, child.permission ? [child.permission] : [], false);
    }
  }
  return items;
}

/** Everything the palette may offer this role, before any query is applied. */
export function buildPaletteItems(orgSlug: string, role: MembershipRole, mode: UiMode = "BUSINESS"): PaletteItem[] {
  return [...createCommands(orgSlug, role), ...findCommands(orgSlug, role), ...pageCommands(orgSlug, role, mode)];
}

/** The "Ask the AI Financial Controller" row: navigation with the question prefilled, never an answer or an action. */
export function askAiItem(orgSlug: string, role: MembershipRole, query: string): PaletteItem | null {
  const q = query.trim();
  if (!q || !roleHasPermission(role, "financial_report:read")) return null;
  const trimmed = Array.from(q).slice(0, 500).join("");
  return {
    id: "ask-ai",
    group: "Ask",
    label: `Ask the AI Financial Controller: ${trimmed}`,
    href: `/${orgSlug}/ai-finance?q=${encodeURIComponent(trimmed)}`,
    keywords: [],
    permissions: ["financial_report:read"],
  };
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Filters and ranks items for a typed query: every word must appear in the label or a keyword. Label-prefix first,
 * then a word-start match in the label, then anything else. Stable for equal scores (menu order is kept).
 */
export function filterPaletteItems(items: PaletteItem[], query: string, limit = 8): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const scored: Array<{ item: PaletteItem; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const label = fold(item.label);
    const bare = label.replace(/^(go to|new|find) /, "");
    const haystack = [label, ...item.keywords.map(fold)].join(" | ");
    if (!words.every((w) => haystack.includes(w))) return;
    const joined = words.join(" ");
    let score = 3;
    if (bare.startsWith(joined) || label.startsWith(joined)) score = 0;
    else if (words.every((w) => bare.split(/[^a-z0-9&]+/).some((part) => part.startsWith(w)))) score = 1;
    else if (words.every((w) => label.includes(w))) score = 2;
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}

// --- Recent items (per user, in this browser only; no server state) --------------------------------------------------

export const RECENT_LIMIT = 8;

export interface RecentEntry {
  label: string;
  hint?: string;
  href: string;
  /** What the role needed to be offered it; re-checked on read so a downgraded role does not see stale names. */
  permissions: Permission[];
}

export function recentStorageKey(orgSlug: string, userEmail: string): string {
  return `mm:recent:v1:${encodeURIComponent(userEmail.toLowerCase())}:${orgSlug}`;
}

function isRecentEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === "string" &&
    typeof v.href === "string" &&
    v.href.startsWith("/") &&
    !v.href.startsWith("//") &&
    Array.isArray(v.permissions) &&
    v.permissions.every((p) => typeof p === "string") &&
    (v.hint === undefined || typeof v.hint === "string")
  );
}

/** Parses what is in storage. Anything malformed (hand-edited, older shape, not JSON) yields an empty list. */
export function parseRecents(raw: string | null | undefined): RecentEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** The list after opening `entry`: it moves to the top, duplicates (same href) are dropped, capped at RECENT_LIMIT. */
export function pushRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((r) => r.href !== entry.href)].slice(0, RECENT_LIMIT);
}

/** Recents the CURRENT role may still be offered, as palette items. */
export function recentItems(list: RecentEntry[], role: MembershipRole, orgSlug: string): PaletteItem[] {
  return list
    .filter((r) => r.href.startsWith(`/${orgSlug}`) && holdsAll(role, r.permissions as Permission[]))
    .map((r) => ({
      id: `recent:${r.href}`,
      group: "Recent" as const,
      label: r.label,
      hint: r.hint,
      href: r.href,
      keywords: [],
      permissions: r.permissions as Permission[],
    }));
}

// --- Keyboard shortcut rules ------------------------------------------------------------------------------------------

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when keystrokes at this element are text entry (or a widget that uses letters), so a bare-key shortcut must stay out of the way. */
export function isTypingTarget(target: unknown): boolean {
  const el = target as ElementLike | null | undefined;
  if (!el || typeof el !== "object") return false;
  if (el.tagName && TYPING_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]'));
}

/** Cmd/Ctrl+K: opens (or closes) the palette from anywhere, including from inside a text field. */
export function isPaletteShortcut(e: KeyEventLike): boolean {
  return e.key.toLowerCase() === "k" && Boolean(e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.defaultPrevented;
}

/**
 * The bare "C" shortcut for the Create menu. Never while typing, never with a modifier (so Cmd+C copy and
 * Ctrl+C are untouched), never auto-repeat, and never while a dialog or menu is open (`overlayOpen`).
 */
export function isCreateShortcut(e: KeyEventLike, overlayOpen: boolean): boolean {
  if (e.key !== "c" && e.key !== "C") return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return false;
  if (overlayOpen) return false;
  return !isTypingTarget(e.target);
}
