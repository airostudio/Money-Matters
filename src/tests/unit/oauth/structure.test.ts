import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { RLS_EXEMPT_TABLES } from "@/db/isolation-audit";
import { buildOpenApiDocument } from "@/domain/api/openapi";

/**
 * Structural guarantees about the OAuth source, checked by reading it (like the API slice's discipline tests): sequential
 * database access, no private connection, no raw SQL, no cookie or CORS where there must be none, no credential in a log,
 * and the migration / schema / audit plumbing for every table.
 */
const SRC = path.resolve(__dirname, "../../..");
const ROOT = path.resolve(SRC, "..");

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const DOMAIN = filesIn(path.join(SRC, "domain/oauth"));
const SURFACE = [
  ...DOMAIN,
  ...filesIn(path.join(SRC, "app/oauth")),
  ...filesIn(path.join(SRC, "app/api/oauth")),
  ...filesIn(path.join(SRC, "app/.well-known")),
  ...filesIn(path.join(SRC, "app/[orgSlug]/settings/oauth-apps")),
  ...filesIn(path.join(SRC, "app/app/authorised-apps")),
  path.join(SRC, "components/shell/oauth-app-forms.tsx"),
  path.join(SRC, "domain/api/api-auth.ts"),
];
const read = (f: string) => readFileSync(f, "utf8");
/** Source with comments removed, so prose describing a forbidden thing is not mistaken for using it. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (f: string) => path.relative(SRC, f);

describe("OAuth modules: database discipline", () => {
  it("covers a meaningful set of files", () => {
    expect(DOMAIN.length).toBeGreaterThanOrEqual(15);
    expect(SURFACE.length).toBeGreaterThan(25);
  });

  it("no Promise.all / allSettled / race / any anywhere in the OAuth surface (sequential database access only)", () => {
    for (const f of SURFACE) expect(code(f), rel(f)).not.toMatch(/Promise\.(all|allSettled|race|any)\b/);
  });

  it("no raw SQL anywhere in the OAuth surface: sql.raw is pinned at ZERO", () => {
    for (const f of SURFACE) expect(code(f), rel(f)).not.toMatch(/sql\.raw\(/);
  });

  it("no private database connection (no pg Pool / Client, no drizzle() construction, no connection string)", () => {
    for (const f of SURFACE) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/from ["']pg["']/);
      expect(c, rel(f)).not.toMatch(/new (Pool|Client)\(/);
      expect(c, rel(f)).not.toMatch(/drizzle\(/);
      expect(c, rel(f)).not.toMatch(/DIRECT_DATABASE_URL|connectionString/);
    }
  });

  it("only the three non-tenant lookup modules touch the bare `db` handle; everything else is inside withTenant", () => {
    const allowed = new Set(["domain/oauth/client-lookup.ts", "domain/oauth/bearer.ts", "domain/oauth/rate-limit.ts"]);
    for (const f of DOMAIN) expect(/from ["']@\/db\/client["']/.test(code(f)), rel(f)).toBe(allowed.has(rel(f)));
    for (const f of SURFACE.filter((x) => /^(app|components)\//.test(rel(x)))) {
      expect(code(f), rel(f)).not.toMatch(/from ["']@\/db\/(tenant|user-scope|client)["']/);
    }
  });

  it("no module opens a tenant transaction inside another's callback: withTenant callers are the services and the two flows", () => {
    const callers = DOMAIN.filter((f) => /\bwithTenant\(/.test(code(f))).map(rel).sort();
    expect(callers).toEqual(["domain/oauth/app-service.ts", "domain/oauth/authorize-service.ts", "domain/oauth/grant-service.ts", "domain/oauth/token-service.ts"]);
  });

  it("no new query in the shared layout / shell / withTenant: none of them mentions OAuth", () => {
    for (const f of [path.join(SRC, "db/tenant.ts"), path.join(SRC, "app/layout.tsx"), path.join(SRC, "app/[orgSlug]/layout.tsx"), path.join(SRC, "components/shell/dashboard-shell.tsx"), path.join(SRC, "components/shell/sidebar.tsx"), path.join(SRC, "components/shell/topbar.tsx")]) {
      if (existsSync(f)) expect(code(f), rel(f)).not.toMatch(/oauth/i);
    }
  });

  it("the bearer lookup reads the organization's archive flag in the SAME join (no extra query), like API keys", () => {
    const bearer = code(path.join(SRC, "domain/oauth/bearer.ts"));
    expect(bearer).toMatch(/innerJoin\(organizations, eq\(organizations\.id, oauthAccessTokens\.organizationId\)\)/);
    expect(bearer).toMatch(/organizationArchivedAt: organizations\.archivedAt/);
    expect(bearer.match(/\.from\(/g)?.length).toBe(1);
  });

  it("archived organizations are refused by the authorize and token flows, in the statement that loads the app", () => {
    expect(code(path.join(SRC, "domain/oauth/authorize-service.ts"))).toMatch(/orgArchivedAt: organizations\.archivedAt[\s\S]*if \(row\.orgArchivedAt\) return \{ kind: "error_page", reason: "organization_archived" \}/);
    const token = code(path.join(SRC, "domain/oauth/token-service.ts"));
    expect(token).toMatch(/archivedAt: organizations\.archivedAt/);
    expect(token.match(/if \(orgArchived\) return fail/g)?.length).toBe(2);
  });
});

describe("OAuth modules: cookies, CORS, logging, secrets", () => {
  it("the domain layer never touches a cookie or the session; only the consent page and decision route read the session", () => {
    for (const f of DOMAIN) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/next\/headers|cookies\(\)|Set-Cookie|set-cookie|\.cookies\b/i);
      expect(c, rel(f)).not.toMatch(/next-auth|@\/lib\/session|getServerSession|getToken/);
    }
    for (const f of [...filesIn(path.join(SRC, "app/api/oauth")), ...filesIn(path.join(SRC, "app/.well-known"))]) {
      expect(code(f), rel(f)).not.toMatch(/next-auth|@\/lib\/session|getServerSession|cookies|headers\(\)/);
    }
    const sessionUsers = SURFACE.filter((f) => /@\/lib\/session/.test(code(f))).map(rel).sort();
    expect(sessionUsers).toEqual([
      "app/[orgSlug]/settings/oauth-apps/actions.ts",
      "app/[orgSlug]/settings/oauth-apps/page.tsx",
      "app/app/authorised-apps/actions.ts",
      "app/app/authorised-apps/page.tsx",
      "app/oauth/authorize/decision/route.ts",
      "app/oauth/authorize/page.tsx",
    ]);
  });

  it("CORS: ONLY the public discovery document sends an Access-Control header; the token and revocation endpoints never do", () => {
    const withCors = SURFACE.filter((f) => /access-control-/i.test(code(f))).map(rel);
    expect(withCors).toEqual(["app/.well-known/oauth-authorization-server/route.ts"]);
    const wellKnown = code(path.join(SRC, "app/.well-known/oauth-authorization-server/route.ts"));
    expect(wellKnown).toMatch(/export function GET/);
    expect(wellKnown).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE|OPTIONS)/);
  });

  it("the token and revocation routes bind POST only (any other method is a 405 from the middleware or the route)", () => {
    for (const name of ["token", "revoke"]) {
      const c = code(path.join(SRC, `app/api/oauth/${name}/route.ts`));
      expect(c).toMatch(/export const POST/);
      expect(c).not.toMatch(/export const (PUT|PATCH|DELETE|OPTIONS)/);
    }
    const mw = read(path.join(SRC, "middleware.ts"));
    expect(mw).toContain('const OAUTH_API_PREFIX = "/api/oauth/"');
    expect(mw).toMatch(/request\.method !== "POST"/);
    expect(mw).toContain('headers.delete("cookie")');
    expect(mw.indexOf("isOAuthApiPath(pathname)")).toBeLessThan(mw.indexOf("getToken("));
  });

  it("every token / revocation response is no-store; the consent hand-off is no-store with no Referer", () => {
    const http = code(path.join(SRC, "domain/oauth/http.ts"));
    expect(http).toMatch(/"Cache-Control": "no-store"/);
    expect(http).toMatch(/Pragma: "no-cache"/);
    const decision = code(path.join(SRC, "app/oauth/authorize/decision/route.ts"));
    expect(decision).toMatch(/"Cache-Control": "no-store"/);
    expect(decision).toMatch(/"Referrer-Policy": "no-referrer"/);
  });

  it("clickjacking: the whole site (so the consent page) is X-Frame-Options DENY and CSP frame-ancestors 'none'", () => {
    const config = read(path.join(ROOT, "next.config.mjs"));
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toMatch(/X-Frame-Options", value: "DENY"/);
  });

  it("logs nothing but a fixed label and the first line of an unexpected error - never a header, body, code or token", () => {
    for (const f of SURFACE) {
      const logs = code(f).match(/console\.(log|info|warn|error|debug)\([^;]*;/g) ?? [];
      for (const line of logs) {
        expect(line, rel(f)).not.toMatch(/authorization|secret|headers|request\.|\bbody\b|bearer|token|\bcode\b|verifier|params/i);
      }
    }
    const all = DOMAIN.map((f) => (code(f).match(/console\.\w+\(/g) ?? []).length).reduce((a, b) => a + b, 0);
    expect(all).toBe(1); // the single "[oauth] <endpoint> failed: <first line>" in http.ts
  });

  it("no JWT: nothing decodes or signs a token, and no JWT library is imported", () => {
    for (const f of DOMAIN) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/jsonwebtoken|from ["']jose["']|jwt\./i);
      expect(c, rel(f)).not.toMatch(/atob\(|\.split\("\."\)/);
    }
  });

  it("management listings never select a secret or its hash; the token tables are not read by management code", () => {
    const app = code(path.join(SRC, "domain/oauth/app-service.ts"));
    const list = app.slice(app.indexOf("async list("), app.indexOf("async update("));
    expect(list).not.toMatch(/secretHash|secret_hash|tokenHash|codeHash/);
    const grants = code(path.join(SRC, "domain/oauth/grant-service.ts"));
    expect(grants).not.toMatch(/secretHash|tokenHash|codeHash|oauthAccessTokens|oauthRefreshTokens|oauthAuthorizationCodes/);
    const page = code(path.join(SRC, "app/[orgSlug]/settings/oauth-apps/page.tsx"));
    expect(page).not.toMatch(/secretHash|clientSecret|secret_hash/);
  });

  it("the open-redirect surface: the only redirect() with an external target is the validated authorize outcome", () => {
    const page = code(path.join(SRC, "app/oauth/authorize/page.tsx"));
    expect(page.match(/redirect\(/g)?.length).toBe(2);
    expect(page).toMatch(/redirect\(`\/login\?next=\$\{encodeURIComponent\(currentUrl\(searchParams\)\)\}`\)/);
    expect(page).toMatch(/redirect\(outcome\.url\)/);
    const decision = code(path.join(SRC, "app/oauth/authorize/decision/route.ts"));
    expect(decision).not.toMatch(/Location: (raw|form|request)/);
    expect(decision).toMatch(/Location: `\/oauth\/error\?reason=/);
  });

  it("the consent decision enforces all four layers: form content type, Origin, session, CSRF token", () => {
    const whole = code(path.join(SRC, "app/oauth/authorize/decision/route.ts"));
    const decision = whole.slice(whole.indexOf("export async function POST"));
    const order = ["application.{1,2}x-www-form-urlencoded", "sameOrigin\\(request\\)", "getCurrentUser\\(\\)", "verifyConsentToken\\("].map((p) => decision.search(new RegExp(p)));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Consent is never skippable: no prompt=none, no auto-approve, no first-party shortcut.
    for (const f of DOMAIN) expect(code(f), rel(f)).not.toMatch(/prompt\s*[=:]|autoApprove|firstParty|skipConsent|trusted/i);
  });
});

describe("OAuth plumbing: migrations, audit, OpenAPI", () => {
  const migrations = readdirSync(path.join(ROOT, "drizzle")).filter((f) => f.endsWith(".sql"));
  const rls = read(path.join(ROOT, "drizzle", migrations.find((f) => f.includes("oauth_slice4_row_level_security"))!));

  it("every tenant OAuth table is ENABLE + FORCE row-level security with a policy keyed on app.current_org_id", () => {
    for (const table of ["oauth_apps", "oauth_grants", "oauth_authorization_codes", "oauth_refresh_tokens"]) {
      expect(rls, table).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(rls, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(rls, table).toMatch(new RegExp(`CREATE POLICY tenant_isolation_${table} ON ${table}[\\s\\S]*?app\\.current_org_id[\\s\\S]*?WITH CHECK \\(organization_id = nullif\\(current_setting\\('app\\.current_org_id', true\\), ''\\)::uuid\\)`));
    }
  });

  it("the two lookup indexes are exempt from the tenant audit, and writes (not reads) are bound to the transaction's organization", () => {
    expect(RLS_EXEMPT_TABLES.has("oauth_client_index")).toBe(true);
    expect(RLS_EXEMPT_TABLES.has("oauth_access_tokens")).toBe(true);
    for (const table of ["oauth_client_index", "oauth_access_tokens"]) {
      expect(rls).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(rls).toContain(`CREATE POLICY ${table}_read ON ${table} FOR SELECT USING (true);`);
    }
    expect(rls).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]* ON oauth_client_index/);
    expect(rls).not.toMatch(/GRANT UPDATE \([^)]*(secret_hash|prefix|grant_id|scopes)[^)]*\) ON oauth_access_tokens/);
  });

  it("the schema and the journal know both migrations, and the test truncation list resets every OAuth table", () => {
    const journal = JSON.parse(read(path.join(ROOT, "drizzle/meta/_journal.json"))) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0050_oauth_slice4_schema");
    expect(tags).toContain("0051_oauth_slice4_row_level_security");
    const helper = read(path.join(SRC, "tests/helpers/db.ts"));
    for (const t of ["oauth_apps", "oauth_client_index", "oauth_grants", "oauth_authorization_codes", "oauth_refresh_tokens", "oauth_access_tokens", "oauth_rate_windows"]) expect(helper).toContain(`"${t}"`);
  });

  it("'oauth' is a reserved organization slug (the /oauth routes could never be shadowed or claimed)", () => {
    expect(read(path.join(SRC, "domain/organizations/organization-service.ts"))).toMatch(/RESERVED_SLUGS = new Set\(\[[^\]]*"oauth"/);
  });

  it("the OpenAPI document declares oauth2 with ONLY the authorization-code flow and every protected operation accepts it", () => {
    const doc = buildOpenApiDocument() as {
      components: { securitySchemes: Record<string, { type: string; flows?: Record<string, { authorizationUrl: string; tokenUrl: string; scopes: Record<string, string> }> }> };
      paths: Record<string, Record<string, { security?: Array<Record<string, string[]>> }>>;
      security: unknown[];
    };
    const oauth2 = doc.components.securitySchemes.oauth2;
    expect(oauth2?.type).toBe("oauth2");
    expect(Object.keys(oauth2?.flows ?? {})).toEqual(["authorizationCode"]);
    expect(oauth2?.flows?.authorizationCode).toMatchObject({ authorizationUrl: "/oauth/authorize", tokenUrl: "/api/oauth/token" });
    expect(Object.keys(oauth2?.flows?.authorizationCode?.scopes ?? {})).toHaveLength(10);
    expect(doc.components.securitySchemes.bearerAuth?.type).toBe("http");
    let protectedOps = 0;
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        if (!op.security || op.security.length === 0) continue;
        protectedOps += 1;
        expect(op.security.map((s) => Object.keys(s)[0])).toEqual(["bearerAuth", "oauth2"]);
      }
    }
    expect(protectedOps).toBeGreaterThan(15);
  });
});
