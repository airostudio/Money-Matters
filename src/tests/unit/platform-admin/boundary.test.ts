import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";

const ROOT = path.resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every file that makes up the platform admin section: the domain modules, the gate, and the pages/actions/routes. */
const ADMIN_FILES = [
  ...sourceFiles(path.join(ROOT, "domain/platform-admin")),
  ...sourceFiles(path.join(ROOT, "app/admin")),
  path.join(ROOT, "lib/platform-admin.ts"),
];

/**
 * The ONLY schema symbols the admin section may import: the three non-tenant
 * tables, its own platform-level table, and enums. A tenant-scoped table
 * (invoices, journals, accounts, payroll, bank data, ...) must never appear.
 */
const ALLOWED_SCHEMA_SYMBOLS = new Set([
  "users",
  "organizations",
  "organizationMemberships",
  "platformAdminAuditLogs",
  "membershipRoleEnum",
  "planTierEnum",
]);

/** Domain modules the admin section may call into (everything else is tenant business logic). */
const ALLOWED_DOMAIN_IMPORTS = [
  "@/domain/platform-admin/",
  "@/domain/organizations/membership-rules",
  "@/domain/audit/audit-service",
  "@/domain/auth/email",
  "@/domain/permissions/roles",
];

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

describe("platform admin boundary (structural)", () => {
  it("found the admin source files", () => {
    expect(ADMIN_FILES.length).toBeGreaterThan(10);
  });

  it("imports only non-tenant schema symbols", () => {
    for (const file of ADMIN_FILES) {
      for (const imp of importsOf(readFileSync(file, "utf8"))) {
        if (imp.from !== "@/db/schema") continue;
        for (const name of imp.names) {
          expect(ALLOWED_SCHEMA_SYMBOLS.has(name), `${path.relative(ROOT, file)} imports "${name}" from the schema`).toBe(true);
        }
      }
    }
  });

  it("never references a tenant-scoped table by name", () => {
    const tenantTables: string[] = [];
    for (const [exportName, value] of Object.entries(schema)) {
      const isTable = typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
      if (!isTable) continue;
      const cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      const tenantScoped = cfg.columns.some((c) => c.name === "organization_id");
      if (tenantScoped && exportName !== "organizationMemberships") tenantTables.push(exportName);
    }
    expect(tenantTables.length).toBeGreaterThan(20);

    for (const file of ADMIN_FILES) {
      // Strip comments so prose that mentions e.g. "invoices" doesn't count.
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const table of tenantTables) {
        expect(new RegExp(`\\b${table}\\b`).test(code), `${path.relative(ROOT, file)} mentions tenant table ${table}`).toBe(false);
      }
    }
  });

  it("does not read tenant tables through raw SQL either", () => {
    const tenantSqlNames: string[] = [];
    for (const value of Object.values(schema)) {
      const isTable = typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
      if (!isTable) continue;
      const cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      if (cfg.columns.some((c) => c.name === "organization_id") && cfg.name !== "organization_memberships") {
        tenantSqlNames.push(cfg.name);
      }
    }
    for (const file of ADMIN_FILES) {
      const code = readFileSync(file, "utf8");
      const sqlBlocks = [...code.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]!);
      for (const block of sqlBlocks) {
        for (const table of tenantSqlNames) {
          expect(
            new RegExp(`\\b(from|join)\\s+"?${table}"?\\b`, "i").test(block),
            `${path.relative(ROOT, file)} reads tenant table ${table} in raw SQL`,
          ).toBe(false);
        }
      }
    }
  });

  it("only calls into the allow-listed domain modules, and never opens a privileged connection", () => {
    for (const file of ADMIN_FILES) {
      const code = readFileSync(file, "utf8");
      for (const imp of importsOf(code)) {
        if (imp.from.startsWith("@/domain/")) {
          expect(
            ALLOWED_DOMAIN_IMPORTS.some((p) => imp.from.startsWith(p)),
            `${path.relative(ROOT, file)} imports ${imp.from}`,
          ).toBe(true);
        }
      }
      expect(/DIRECT_DATABASE_URL|new Pool\(|from "pg"/.test(code), `${path.relative(ROOT, file)} opens its own connection`).toBe(false);
    }
  });

  it("every admin page, route handler and server action calls the platform admin gate", () => {
    const gated = ADMIN_FILES.filter((f) => /(page|route|actions)\.tsx?$/.test(f) && f.includes(`${path.sep}app${path.sep}admin`));
    expect(gated.length).toBeGreaterThanOrEqual(8);
    for (const file of gated) {
      expect(readFileSync(file, "utf8").includes("requirePlatformAdmin"), `${path.relative(ROOT, file)} lacks requirePlatformAdmin`).toBe(true);
    }
    expect(readFileSync(path.join(ROOT, "app/admin/layout.tsx"), "utf8")).toContain("requirePlatformAdmin");
  });
});

describe("AI Financial Controller boundary", () => {
  it("exposes no admin-related tool", () => {
    const tools = [...buildControllerTools([]), ...buildWriteTools("question", "model")];
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      const haystack = `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
      expect(haystack, tool.name).not.toMatch(/platform|admin|seat[_ ]?limit|suspend|plan[_ ]?tier/i);
    }
  });

  it("no ai-controller module imports the platform admin domain or gate", () => {
    for (const file of sourceFiles(path.join(ROOT, "domain/ai-controller"))) {
      const code = readFileSync(file, "utf8");
      expect(code, path.relative(ROOT, file)).not.toMatch(/platform-admin/);
    }
  });
});
