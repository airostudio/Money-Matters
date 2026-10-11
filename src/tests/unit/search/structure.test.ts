import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guarantees for global search, the command palette and the Create menu (master spec s.56/57/80), read from
 * the source: search runs only on demand and never in the page-render hot path, the UI imports no domain service, the
 * query text reaches SQL only as a bound parameter, and commands only navigate.
 */
const SRC = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
/** Source with comments removed, so prose describing a call is not mistaken for making it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const filesIn = (dir: string): string[] =>
  readdirSync(path.join(SRC, dir)).flatMap((n) => {
    const rel = dir === "." ? n : `${dir}/${n}`;
    return statSync(path.join(SRC, rel)).isDirectory() ? filesIn(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
  });

const UI_FILES = [
  "components/shell/command-palette.tsx",
  "components/shell/palette-body.tsx",
  "components/shell/palette-model.ts",
  "components/shell/create-menu.tsx",
  "components/shell/topbar.tsx",
  "components/shell/nav-config.ts",
];
const SEARCH_DOMAIN = filesIn("domain/search");

describe("the search UI is pure presentation over static data", () => {
  it("imports no domain service, no database, no server-only module, no server action", () => {
    const ALLOWED = [
      "@/domain/permissions/roles",
      "@/domain/search/entities",
      "@/domain/search/query",
      "@/domain/search/types",
      "@/domain/search/commands",
    ];
    for (const f of UI_FILES) {
      const imports = [...code(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const i of imports) {
        if (i.startsWith("@/domain/")) expect(ALLOWED, `${f} imports ${i}`).toContain(i);
        expect(i, f).not.toMatch(/^@\/db|server-only|\/actions$|^pg$|^drizzle-orm/);
      }
      expect(code(f), f).not.toMatch(/["']use server["']/);
    }
  });

  it("commands only navigate: the palette calls router.push and the one search fetch, nothing that mutates", () => {
    const palette = code("components/shell/command-palette.tsx");
    expect(palette).toMatch(/router\.push\(/);
    expect([...palette.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(palette).toContain("/api/search?org=");
    expect(palette).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
    expect(palette).not.toMatch(/Action\(|\.mutate\(|XMLHttpRequest|sendBeacon/);
    // No AI call from the palette: the Ask row is a link to the AI page with the question in the URL.
    expect(palette).not.toMatch(/anthropic|openai|ai-controller|askController/i);
    expect(code("components/shell/palette-model.ts")).toMatch(/ai-finance\?q=/);
  });

  it("debounces and cancels: a timer before the request, an AbortController aborted on cleanup, a two-character floor", () => {
    const palette = code("components/shell/command-palette.tsx");
    expect(palette).toMatch(/const DEBOUNCE_MS = (\d+)/);
    expect(Number(palette.match(/const DEBOUNCE_MS = (\d+)/)![1])).toBeGreaterThanOrEqual(200);
    expect(palette).toMatch(/new AbortController\(\)/);
    expect(palette).toMatch(/signal:\s*controller\.signal/);
    expect(palette).toMatch(/controller\.abort\(\)/);
    expect(palette).toMatch(/clearTimeout\(timer\)/);
    expect(palette).toMatch(/MIN_QUERY_LENGTH/);
    // The fetch lives inside the debounced timer callback, not in an event handler or at render.
    const timerBody = palette.slice(palette.indexOf("window.setTimeout"), palette.indexOf("}, DEBOUNCE_MS)"));
    expect(timerBody).toMatch(/fetch\(/);
  });

  it("recents use localStorage only inside try/catch, and nothing else is stored client-side", () => {
    const palette = code("components/shell/command-palette.tsx");
    const uses = [...palette.matchAll(/localStorage/g)].length;
    const guarded = [...palette.matchAll(/try\s*\{[^}]*localStorage[^}]*\}\s*catch/g)].length;
    expect(uses).toBeGreaterThan(0);
    expect(guarded).toBe(uses);
    expect(palette).not.toMatch(/sessionStorage|indexedDB|document\.cookie/);
  });

  it("the dialog is Radix (focus trap, Escape, aria-modal) with a title and a description", () => {
    const palette = code("components/shell/command-palette.tsx");
    expect(palette).toContain('@radix-ui/react-dialog');
    expect(palette).toMatch(/<Dialog\.Title/);
    expect(palette).toMatch(/<Dialog\.Description/);
    expect(palette).toMatch(/aria-describedby/);
    expect(palette).toMatch(/aria-keyshortcuts="Control\+K Meta\+K"/);
    expect(palette).toMatch(/isPaletteShortcut/);
  });

  it("the Create menu is a Radix menu hidden when empty, with the guarded C shortcut", () => {
    const menu = code("components/shell/create-menu.tsx");
    expect(menu).toContain("@radix-ui/react-dropdown-menu");
    expect(menu).toMatch(/if \(!available\) return null/);
    expect(menu).toMatch(/isCreateShortcut\(e, overlayOpen\)/);
    expect(menu).toMatch(/aria-keyshortcuts="C"/);
  });
});

describe("search stays out of the page-render hot path", () => {
  const HOT = [
    "app/[orgSlug]/layout.tsx",
    "components/shell/dashboard-shell.tsx",
    "components/shell/sidebar.tsx",
    "components/shell/topbar.tsx",
    "components/shell/mobile-nav.tsx",
    "components/shell/nav-links.tsx",
    "components/shell/nav-config.ts",
    "db/tenant.ts",
  ];
  it("the layout, shell and withTenant never reference the search service or endpoint", () => {
    for (const f of HOT) {
      expect(code(f), f).not.toMatch(/SearchService|search-service|\/api\/search/);
    }
  });

  it("only the route handler imports the search service", () => {
    const importers = filesIn(".")
      .filter((f) => !f.startsWith("tests/") && /domain\/search\/search-service/.test(code(f)))
      .sort();
    expect(importers).toEqual(["app/api/search/route.ts"]);
  });

  it("the browser-side modules import only the pure parts of the search domain", () => {
    for (const f of ["components/shell/command-palette.tsx", "components/shell/palette-model.ts", "components/shell/palette-body.tsx"]) {
      expect(code(f), f).not.toMatch(/search-service/);
    }
  });
});

describe("search domain code: bounded, sequential, parameterised", () => {
  it("no parallel database fan-out, no private connection, no timers, no raw SQL building, no logging", () => {
    for (const f of [...SEARCH_DOMAIN, "app/api/search/route.ts"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/Promise\.(all|allSettled|race|any)\b/);
      expect(c, f).not.toMatch(/from ["']pg["']|new (Pool|Client)\(|DIRECT_DATABASE_URL|connectionString/);
      expect(c, f).not.toMatch(/\b(setInterval|setTimeout)\s*\(/);
      expect(c, f).not.toMatch(/sql\.raw\(/);
      expect(c, f).not.toMatch(/console\./);
      expect(c, f).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
  });

  it("the service is one tenant transaction with one search statement, a hard per-type LIMIT and a statement timeout", () => {
    const c = code("domain/search/search-service.ts");
    expect([...c.matchAll(/withTenant\(/g)]).toHaveLength(1);
    expect(c).toMatch(/UNION ALL/);
    expect(c).toMatch(/LIMIT \$\{PER_KIND_LIMIT\}/);
    expect(c).toMatch(/set_config\('statement_timeout'/);
    expect(c).toMatch(/PER_KIND_LIMIT/);
    // Only human actors; the kinds come from the role registry.
    expect(c).toMatch(/\(actor\.type \?\? "HUMAN"\) !== "HUMAN"/);
    expect(c).toMatch(/searchableKindsFor\(actor\.role, actor\.grantedPermissions\)/);
  });

  it("every match uses the escaped patterns as bound parameters, with ESCAPE '!'", () => {
    const c = code("domain/search/search-service.ts");
    expect(c).toContain("ILIKE ${pattern} ESCAPE '!'");
    // The raw query text is never interpolated into a template that becomes SQL: only patterns and the amount string.
    expect(c).not.toMatch(/\$\{(query|rawQuery)\}/);
    expect(c).not.toMatch(/ILIKE '%/);
  });

  it("selects named columns only: no SELECT *, no employee tax / bank / pay / leave column", () => {
    const c = code("domain/search/search-service.ts");
    // The single outer `SELECT * FROM (<union>)` is over the named-column branches; branches themselves never use *.
    expect([...c.matchAll(/SELECT \*/g)]).toHaveLength(1);
    expect(c).not.toMatch(/\b(tfn|annual_salary|hourly_rate|bank_bsb|bank_account_number|bank_account_name|super_|leave_balance|tax_number|phone|billing_address)\b/i);
  });
});

describe("the search endpoint", () => {
  const route = () => code("app/api/search/route.ts");

  it("is GET only, authenticated by the session cookie, membership-checked, never cached", () => {
    const c = route();
    expect(c).toMatch(/export async function GET\(/);
    expect(c).not.toMatch(/export async function (POST|PUT|PATCH|DELETE|OPTIONS)\b/);
    expect(c).toMatch(/requireOrgAndActor\(/);
    expect(c).toMatch(/"Cache-Control": "no-store"/);
    // API keys / OAuth tokens are never looked at: no Authorization header handling, no API-key or OAuth service.
    expect(c).not.toMatch(/authorization|api-auth|ApiKey|oauth/i);
  });

  it("refuses cross-site requests and maps failures to non-revealing statuses", () => {
    const c = route();
    expect(c).toMatch(/sec-fetch-site/);
    expect(c).toMatch(/headers\.get\("origin"\)/);
    expect(c).toMatch(/NotAuthenticatedError[\s\S]{0,80}401/);
    expect(c).toMatch(/OrganizationArchivedError/);
    expect(c).toMatch(/search_unavailable/);
    // A non-member, an unknown slug and an archived company all answer the same 404.
    expect(c).toMatch(/NotAMemberError[\s\S]{0,200}OrganizationNotFoundError[\s\S]{0,200}OrganizationArchivedError[\s\S]{0,120}404/);
  });

  it("the middleware lets /api/search through to answer its own JSON 401 instead of redirecting a fetch to the login page", () => {
    const mw = code("middleware.ts");
    const at = mw.indexOf('pathname === "/api/search"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(mw.indexOf("getToken("));
  });
});
