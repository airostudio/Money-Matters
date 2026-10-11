import { describe, expect, it } from "vitest";
import { membershipRoleEnum } from "@/db/schema";
import { NAV_ITEMS } from "@/components/shell/nav-config";
import {
  RECENT_LIMIT,
  askAiItem,
  buildPaletteItems,
  filterPaletteItems,
  isCreateShortcut,
  isPaletteShortcut,
  isTypingTarget,
  parseRecents,
  pushRecent,
  recentItems,
  recentStorageKey,
  type RecentEntry,
} from "@/components/shell/palette-model";

const labels = (role: Parameters<typeof buildPaletteItems>[1], mode: "BUSINESS" | "ACCOUNTANT" = "ACCOUNTANT") =>
  buildPaletteItems("acme", role, mode).map((i) => i.label);

describe("palette items per role", () => {
  it("an owner is offered every command in the brief and a Go to for every navigation destination", () => {
    const l = labels("OWNER");
    for (const c of [
      "New invoice", "New quote", "New bill", "New expense claim", "New customer", "New supplier",
      "New purchase order", "New project", "New journal entry", "Reconcile banking", "Find unpaid invoices",
    ]) expect(l, c).toContain(c);

    const items = buildPaletteItems("acme", "OWNER", "ACCOUNTANT");
    const hrefs = new Set(items.map((i) => i.href));
    for (const nav of NAV_ITEMS) {
      if (nav.absoluteHref) expect(hrefs.has(nav.absoluteHref), nav.label).toBe(true);
      else expect(hrefs.has(`/acme${nav.href}`) || nav.href === "", nav.label).toBe(true);
      for (const child of nav.children ?? []) expect(hrefs.has(`/acme${child.href}`), `${nav.label} > ${child.label}`).toBe(true);
    }
    expect(l).toContain("Go to Profit & Loss");
    expect(l).toContain("Go to BAS / GST");
    expect(l).toContain("Go to Aged Receivables");
    expect(l).toContain("Go to Practice"); // accountant mode only
    expect(labels("OWNER", "BUSINESS")).not.toContain("Go to Practice");
  });

  it("commands only navigate: every item is a path into the organization (or the practice), never an action", () => {
    for (const role of membershipRoleEnum.enumValues) {
      for (const item of buildPaletteItems("acme", role, "ACCOUNTANT")) {
        expect(item.href, item.label).toMatch(/^\/(acme|practice)(\/|$|\?)/);
        expect(item.href).not.toMatch(/\/\//);
        expect(["Create", "Find", "Go to"]).toContain(item.group);
      }
    }
  });

  it("a read-only role gets no 'New ...' command and no reconcile, but can find unpaid invoices and open reports", () => {
    const l = labels("READ_ONLY");
    expect(l.filter((x) => x.startsWith("New "))).toEqual([]);
    expect(l).not.toContain("Reconcile banking");
    expect(l).not.toContain("Go to Money"); // the page also needs bank_transaction:reconcile
    expect(l).toContain("Find unpaid invoices");
    expect(l).toContain("Find overdue invoices");
    expect(l).toContain("Go to Profit & Loss");
    expect(l).not.toContain("Go to Employees");
    expect(l).not.toContain("Go to Tax Codes");
  });

  it("an employee sees only their own corners of the app", () => {
    const l = labels("EMPLOYEE");
    expect(l.filter((x) => x.startsWith("New ") || x.startsWith("Find ") || x === "Reconcile banking")).toEqual([]);
    expect(l).toContain("Go to My pay and leave");
    expect(l).toContain("Go to Expenses");
    expect(l).toContain("Go to Notifications");
    for (const hidden of ["Go to Employees", "Go to Invoices", "Go to Profit & Loss", "Go to Chart of Accounts", "Go to Money", "Go to Purchases", "Go to AI Finance"]) {
      expect(l, hidden).not.toContain(hidden);
    }
  });

  it("an accounts-receivable clerk can raise invoices and find unpaid ones but not post journals or reconcile", () => {
    const l = labels("ACCOUNTS_RECEIVABLE");
    expect(l).toContain("New invoice");
    expect(l).toContain("Find unpaid invoices");
    expect(l).not.toContain("New journal entry");
    expect(l).not.toContain("New bill");
    expect(l).not.toContain("Reconcile banking");
  });

  it("matches the Create menu: the 'New ...' commands are exactly the menu's entries for that role", async () => {
    const { createActionsFor } = await import("@/components/shell/nav-config");
    for (const role of membershipRoleEnum.enumValues) {
      const commands = buildPaletteItems("acme", role).filter((i) => i.group === "Create").map((i) => i.label).sort();
      expect(commands, role).toEqual(createActionsFor(role).map((a) => a.commandLabel).sort());
    }
  });

  it("uses the Business-mode labels where the menu does", () => {
    expect(labels("OWNER", "BUSINESS")).toContain("Go to Accounts list");
    expect(labels("OWNER", "ACCOUNTANT")).toContain("Go to Chart of Accounts");
  });
});

describe("Ask the AI Financial Controller row", () => {
  it("is offered with the question prefilled to roles that can read financial reports, as navigation only", () => {
    const ask = askAiItem("acme", "ACCOUNTANT", "who owes us money?")!;
    expect(ask.label).toBe("Ask the AI Financial Controller: who owes us money?");
    expect(ask.href).toBe("/acme/ai-finance?q=who%20owes%20us%20money%3F");
    expect(ask.permissions).toEqual(["financial_report:read"]);
  });

  it("is withheld from roles without financial_report:read and for an empty query", () => {
    for (const role of ["EMPLOYEE", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "PAYROLL_MANAGER"] as const) {
      expect(askAiItem("acme", role, "anything"), role).toBeNull();
    }
    expect(askAiItem("acme", "OWNER", "   ")).toBeNull();
  });

  it("encodes hostile text and bounds its length", () => {
    const ask = askAiItem("acme", "OWNER", `a&b=c#d?e "quotes" <script>${"x".repeat(900)}`)!;
    expect(ask.href).not.toMatch(/[<>" #]/);
    expect(new URL(`http://x${ask.href}`).searchParams.get("q")!.length).toBeLessThanOrEqual(500);
  });
});

describe("filterPaletteItems", () => {
  const items = buildPaletteItems("acme", "OWNER", "ACCOUNTANT");
  const top = (q: string, n = 3) => filterPaletteItems(items, q, n).map((i) => i.label);

  it("ranks a label that starts with the query above one that merely contains it", () => {
    expect(top("new inv")[0]).toBe("New invoice");
    expect(top("invoices")).toContain("Go to Invoices");
    expect(top("recon")[0]).toBe("Reconcile banking");
  });

  it("finds pages by the words people use", () => {
    expect(top("gst")).toContain("Go to BAS / GST");
    expect(top("p&l")).toContain("Go to Profit & Loss");
    expect(top("debtors", 10)).toContain("Go to Aged Receivables");
    expect(top("aged receivables")).toContain("Go to Aged Receivables");
    expect(top("staff")).toContain("Go to Employees");
  });

  it("is case-, accent- and spacing-insensitive, and every word must match", () => {
    expect(top("  PROFIT   zzz  ")).toEqual([]);
    expect(top("  PROFIT   AND  LOSS ")).toContain("Go to Profit & Loss");
    expect(top("profit loss")).toContain("Go to Profit & Loss");
    expect(top("BALANCE")).toContain("Go to Balance Sheet");
    expect(top("trésorerie")).toEqual([]);
  });

  it("returns nothing for gibberish, honours the limit and returns the head of the list for an empty query", () => {
    expect(top("zzqqxx")).toEqual([]);
    expect(filterPaletteItems(items, "go", 4)).toHaveLength(4);
    expect(filterPaletteItems(items, "", 5)).toHaveLength(5);
  });

  it("treats regex characters in the query as plain text", () => {
    expect(() => filterPaletteItems(items, "(.*[", 5)).not.toThrow();
    expect(filterPaletteItems(items, "(.*[", 5)).toEqual([]);
  });
});

describe("recent items (localStorage, per user and organization)", () => {
  const entry = (n: number, permissions: RecentEntry["permissions"] = []): RecentEntry => ({
    label: `Item ${n}`,
    href: `/acme/sales/invoices/${n}`,
    permissions,
  });

  it("keys storage by user and organization, case-insensitively for the email", () => {
    expect(recentStorageKey("acme", "Sam@Example.test")).toBe(recentStorageKey("acme", "sam@example.test"));
    expect(recentStorageKey("acme", "sam@example.test")).not.toBe(recentStorageKey("other", "sam@example.test"));
    expect(recentStorageKey("acme", "sam@example.test")).not.toBe(recentStorageKey("acme", "kim@example.test"));
  });

  it("survives anything in storage: null, garbage, wrong shapes, unsafe links", () => {
    for (const raw of [null, undefined, "", "not json", "{}", "42", '"str"', "[1,2,3]", "[null]", '[{"label":1}]']) {
      expect(parseRecents(raw as string | null | undefined), String(raw)).toEqual([]);
    }
    const hostile = JSON.stringify([
      { label: "ok", href: "/acme/x", permissions: [] },
      { label: "bad", href: "//evil.example/x", permissions: [] },
      { label: "bad", href: "https://evil.example", permissions: [] },
      { label: "bad", href: "/acme/y", permissions: "none" },
    ]);
    expect(parseRecents(hostile).map((r) => r.label)).toEqual(["ok"]);
  });

  it("moves a re-opened item to the top without duplicating it, and caps the list", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i += 1) list = pushRecent(list, entry(i));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]!.label).toBe(`Item ${RECENT_LIMIT + 4}`);
    const again = pushRecent(list, entry(RECENT_LIMIT));
    expect(again).toHaveLength(RECENT_LIMIT);
    expect(again[0]!.label).toBe(`Item ${RECENT_LIMIT}`);
    expect(again.filter((r) => r.label === `Item ${RECENT_LIMIT}`)).toHaveLength(1);
  });

  it("re-checks permissions and organization on read: a downgraded role does not see stale names", () => {
    const list = [
      entry(1, ["employee:read"]), // an employee's name, remembered while the person could read employees
      entry(2, ["customer_invoice:read"]),
      { label: "Other org", href: "/other/sales/invoices/9", permissions: [] },
    ];
    expect(recentItems(list, "OWNER", "acme").map((r) => r.label)).toEqual(["Item 1", "Item 2"]);
    expect(recentItems(list, "READ_ONLY", "acme").map((r) => r.label)).toEqual(["Item 2"]);
    expect(recentItems(list, "EMPLOYEE", "acme")).toEqual([]);
  });
});

describe("keyboard shortcut rules", () => {
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ...extra });
  const input = { tagName: "INPUT" };

  it("Cmd/Ctrl+K toggles the palette, even from inside a text field, and nothing else does", () => {
    expect(isPaletteShortcut(key("k", { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key("K", { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, target: input }))).toBe(true);
    expect(isPaletteShortcut(key("k"))).toBe(false);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key("j", { ctrlKey: true }))).toBe(false);
    expect(isPaletteShortcut(key("k", { ctrlKey: true, defaultPrevented: true }))).toBe(false);
  });

  it("a bare C opens Create, but never while typing, with a modifier, held down, or with another overlay open", () => {
    expect(isCreateShortcut(key("c", { target: { tagName: "BODY" } }), false)).toBe(true);
    expect(isCreateShortcut(key("C"), false)).toBe(true); // caps lock on, no shift
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(isCreateShortcut(key("c", { target: { tagName } }), false), tagName).toBe(false);
    }
    expect(isCreateShortcut(key("c", { target: { tagName: "DIV", isContentEditable: true } }), false)).toBe(false);
    expect(isCreateShortcut(key("c", { target: { tagName: "DIV", closest: (s: string) => (s.includes("role=\"textbox\"") ? {} : null) } }), false)).toBe(false);
    expect(isCreateShortcut(key("c", { target: { tagName: "DIV", closest: () => null } }), false)).toBe(true);
    expect(isCreateShortcut(key("c", { metaKey: true }), false)).toBe(false); // copy
    expect(isCreateShortcut(key("c", { ctrlKey: true }), false)).toBe(false); // copy
    expect(isCreateShortcut(key("c", { altKey: true }), false)).toBe(false);
    expect(isCreateShortcut(key("c", { shiftKey: true }), false)).toBe(false);
    expect(isCreateShortcut(key("c", { repeat: true }), false)).toBe(false);
    expect(isCreateShortcut(key("c", { defaultPrevented: true }), false)).toBe(false);
    expect(isCreateShortcut(key("c"), true)).toBe(false); // a dialog or menu is open
    expect(isCreateShortcut(key("x"), false)).toBe(false);
  });

  it("isTypingTarget copes with null, text nodes and plain objects", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget("input")).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});
