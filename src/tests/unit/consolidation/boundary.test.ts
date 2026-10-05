import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

const ROOT = path.resolve(__dirname, "../../..");
const REPO = path.resolve(ROOT, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The consolidation domain plus the pages/actions of the group UI. */
const DOMAIN_FILES = sourceFiles(path.join(ROOT, "domain/consolidation"));
const UI_FILES = sourceFiles(path.join(ROOT, "app/app/groups"));
const ALL_FILES = [...DOMAIN_FILES, ...UI_FILES];

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importsOf(source: string): Array<{ names: string[]; from: string }> {
  const out: Array<{ names: string[]; from: string }> = [];
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const names = (m[1] ?? "")
      .replace(/[{}]/g, " ")
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    out.push({ names, from: m[2]! });
  }
  return out;
}

describe("consolidation boundary (structural) — the application-layer design cannot quietly regress", () => {
  it("found the consolidation source files", () => {
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(10);
    expect(UI_FILES.length).toBeGreaterThanOrEqual(5);
  });

  it("never opens a connection of its own or imports a low-level database handle", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = path.relative(ROOT, file);
      expect(/DIRECT_DATABASE_URL|DATABASE_URL|new Pool\(|from "pg"|from 'pg'/.test(code), `${rel} opens its own connection`).toBe(false);
      for (const imp of importsOf(code)) {
        // The raw client (`db`) and the migration/connection plumbing are off limits;
        // only the two scoped wrappers are allowed.
        expect(imp.from, `${rel} imports the raw db client`).not.toBe("@/db/client");
        expect(imp.from, `${rel} imports db connection plumbing`).not.toBe("@/db/connection");
        expect(imp.from, `${rel} imports the migration runner`).not.toBe("@/db/migrate");
        if (imp.from === "@/db/tenant") expect(imp.names.every((n) => ["withTenant", "TenantDb"].includes(n)), `${rel}: ${imp.names}`).toBe(true);
        if (imp.from === "@/db/user-scope") expect(imp.names.every((n) => ["withUserScope", "UserScopeDb"].includes(n)), `${rel}: ${imp.names}`).toBe(true);
      }
    }
  });

  it("never uses raw SQL with a session variable or a role switch, and never sets a scope variable itself", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = path.relative(ROOT, file);
      expect(/set_config|current_setting|app\.current_(org|user)_id|SECURITY DEFINER|SET ROLE|SET SESSION AUTHORIZATION/i.test(code), `${rel} touches session scope`).toBe(false);
    }
  });

  it("never fans out in parallel: no Promise.all / allSettled / race / any anywhere in consolidation", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/Promise\s*\.\s*(all|allSettled|race|any)\b/.test(code), `${path.relative(ROOT, file)} fans out`).toBe(false);
    }
  });

  it("opens tenant transactions only in the group service (entity audit note) and the entity-chart read path — the report engine and orchestrator never call withTenant themselves", () => {
    for (const file of DOMAIN_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = path.relative(ROOT, file);
      if (/withTenant\(/.test(code)) {
        expect(rel.endsWith("group-service.ts"), `${rel} opens a tenant transaction`).toBe(true);
      }
    }
  });

  it("the report orchestrator reaches entity data only through ReportingService / cash-position, with a per-entity Actor", () => {
    const code = readFileSync(path.join(ROOT, "domain/consolidation/consolidation-service.ts"), "utf8");
    expect(code).toContain("ReportingService.getProfitAndLoss");
    expect(code).toContain("ReportingService.getBalanceSheet");
    expect(code).toContain("loadCashPosition");
    expect(code).toContain("entityActorFor"); // the user's real role in THAT entity
    expect(code).toContain("PermissionDeniedError");
    // No tenant tables are imported: consolidation reads books only through the services above.
    const tenantTables = new Set<string>();
    for (const [exportName, value] of Object.entries(schema)) {
      const isTable = typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
      if (!isTable) continue;
      const cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      if (cfg.columns.some((c) => c.name === "organization_id") && exportName !== "organizationMemberships") tenantTables.add(exportName);
    }
    expect(tenantTables.size).toBeGreaterThan(20);
    for (const file of ALL_FILES) {
      for (const imp of importsOf(stripComments(readFileSync(file, "utf8")))) {
        if (imp.from !== "@/db/schema") continue;
        for (const name of imp.names) {
          expect(tenantTables.has(name), `${path.relative(ROOT, file)} imports tenant table ${name}`).toBe(false);
        }
      }
    }
  });

  it("group tables carry no organization_id column (so they can never be mistaken for tenant tables) and always an owner_user_id", () => {
    const groupTables = Object.entries(schema).filter(([name]) => /^entityGroup/.test(name) && !/Enum$/.test(name));
    expect(groupTables.length).toBe(8);
    for (const [name, value] of groupTables) {
      const cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      const cols = cfg.columns.map((c) => c.name);
      expect(cols, name).not.toContain("organization_id");
      expect(cols, name).toContain("owner_user_id");
    }
  });

  it("the migration adds no bypass: no multi-organization predicate, no SECURITY DEFINER, no BYPASSRLS, only the user-scope variable, FORCE on every table", () => {
    const sql = readFileSync(path.join(REPO, "drizzle/0039_consolidation_slice4_row_level_security.sql"), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(/security\s+definer|bypassrls|set\s+role|create\s+(or\s+replace\s+)?function/i.test(code)).toBe(false);
    expect(/app\.current_org_id/.test(code)).toBe(false);
    // Every predicate reads the single user id; none compares to a set.
    expect(/\bany\s*\(|\bin\s*\(|string_to_array|unnest|array\s*\[/i.test(code.replace(/EXISTS\s*\([\s\S]*?\)\s*\)\s*;/gi, ""))).toBe(false);
    const tables = [...code.matchAll(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g)].map((m) => m[1]!);
    expect(tables.length).toBe(8);
    for (const t of tables) {
      expect(code, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(code, t).toMatch(new RegExp(`CREATE POLICY \\w+ ON ${t} `));
    }
    // Every USING / WITH CHECK clause is keyed on the owner and the single user variable.
    const policies = code.split("CREATE POLICY").slice(1);
    for (const p of policies) {
      expect(p).toContain("owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid");
    }
    // The append-only tables are granted SELECT + INSERT and nothing else.
    for (const t of ["entity_group_adjustments", "entity_group_adjustment_lines", "entity_group_audit_logs"]) {
      expect(code).toContain(`GRANT SELECT, INSERT ON ${t} TO mm_app;`);
    }
  });

  it("every group page, layout-less route and server action resolves the current user (no unauthenticated path)", () => {
    const gated = UI_FILES.filter((f) => /(page|actions)\.tsx?$/.test(f));
    expect(gated.length).toBeGreaterThanOrEqual(5);
    for (const file of gated) {
      expect(/getCurrentUser|requireGroupUser/.test(readFileSync(file, "utf8")), `${path.relative(ROOT, file)} lacks an authentication check`).toBe(true);
    }
  });
});
