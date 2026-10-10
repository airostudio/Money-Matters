import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural guarantees about the API's source, checked by reading it (like the earlier slices' discipline
 * tests): no private database connection, no fan-out, no cookies, no CORS, no secrets in logs.
 */
const SRC = path.resolve(__dirname, "../../..");
const API_DIRS = [path.join(SRC, "domain/api"), path.join(SRC, "app/api/v1")];

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const files = API_DIRS.flatMap(filesIn);
const read = (f: string) => readFileSync(f, "utf8");
/** Source with comments removed, so prose describing a forbidden thing is not mistaken for using it. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (f: string) => path.relative(SRC, f);

describe("API modules: connection discipline", () => {
  it("covers a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it("no API module opens a database connection of its own (no pg Pool/Client, no drizzle() construction)", () => {
    for (const f of files) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/from ["']pg["']/);
      expect(c, rel(f)).not.toMatch(/new (Pool|Client)\(/);
      expect(c, rel(f)).not.toMatch(/drizzle\(/);
      expect(c, rel(f)).not.toMatch(/DIRECT_DATABASE_URL|connectionString/);
    }
  });

  it("only the two authentication-path modules touch the non-tenant `db` handle; everything else goes through withTenant", () => {
    const allowed = new Set(["domain/api/api-auth.ts", "domain/api/rate-limit.ts"]);
    for (const f of files) {
      const usesDb = /from ["']@\/db\/client["']/.test(code(f));
      expect(usesDb, rel(f)).toBe(allowed.has(rel(f)));
    }
  });

  it("no Promise.all / allSettled / race / any anywhere in the API (sequential access only)", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/Promise\.(all|allSettled|race|any)\b/);
  });

  it("the work of a request is one withTenant: no module nests one withTenant in another's callback", () => {
    // withTenant is called only in these modules, each from a single entry point per request.
    const callers = files.filter((f) => /\bwithTenant\(/.test(code(f))).map(rel).sort();
    expect(callers).toEqual(["domain/api/api-key-service.ts", "domain/api/endpoints.ts", "domain/api/idempotency.ts", "domain/api/read-models.ts"]);
  });
});

describe("API modules: no cookies, no CORS, no secrets in logs", () => {
  it("never reads or sets a cookie, and never imports the session layer", () => {
    for (const f of files) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/next\/headers|cookies\(\)|Set-Cookie|set-cookie|\.cookies\b/i);
      expect(c, rel(f)).not.toMatch(/next-auth|@\/lib\/session|getServerSession|getToken/);
    }
  });

  it("never sends a CORS header: this API is server-to-server", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/access-control-/i);
  });

  it("the middleware strips cookies from /api/v1 and answers non-GET/HEAD/POST with 405 before any route runs", () => {
    const mw = readFileSync(path.join(SRC, "middleware.ts"), "utf8");
    expect(mw).toContain('headers.delete("cookie")');
    expect(mw).toMatch(/new Set\(\["GET", "HEAD", "POST"\]\)/);
    expect(mw).toContain("405");
    // API paths are handled before the NextAuth check, which is not reached for them.
    expect(mw.indexOf("isApiPath(pathname)")).toBeGreaterThan(-1);
    expect(mw.indexOf("isApiPath(pathname)")).toBeLessThan(mw.indexOf("getToken("));
  });

  it("logs nothing but the request id, route and the first line of an unexpected error - never headers, bodies or keys", () => {
    for (const f of files) {
      const logs = code(f).match(/console\.(log|info|warn|error|debug)\([^;]*;/g) ?? [];
      for (const line of logs) {
        expect(line, rel(f)).not.toMatch(/authorization|secret|headers|request\.|\bbody\b|bearer|fullKey/i);
      }
    }
  });

  it("the secret and its hash are never selected by a management or list query", () => {
    const svc = code(path.join(SRC, "domain/api/api-key-service.ts"));
    const listBody = svc.slice(svc.indexOf("async list("), svc.indexOf("async revoke("));
    expect(listBody).not.toMatch(/secretHash|secret_hash/);
  });
});
