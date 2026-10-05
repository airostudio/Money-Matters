import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

const ROOT = path.resolve(__dirname, "../../..");
const REPO = path.resolve(ROOT, "..");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const PRACTICE_DOMAIN = sourceFiles(path.join(ROOT, "domain/practice"));
const REQUEST_DOMAIN = sourceFiles(path.join(ROOT, "domain/client-requests"));
const DOMAIN_FILES = [...PRACTICE_DOMAIN, ...REQUEST_DOMAIN];
const UI_FILES = [
  ...sourceFiles(path.join(ROOT, "app/practice")),
  ...sourceFiles(path.join(ROOT, "app/[orgSlug]/requests")),
  ...sourceFiles(path.join(ROOT, "app/[orgSlug]/settings/accountant")),
];
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

const rel = (f: string) => path.relative(ROOT, f);

const tableConfigs = Object.entries(schema)
  .filter(([, v]) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
  .map(([exportName, v]) => ({ exportName, cfg: getTableConfig(v as Parameters<typeof getTableConfig>[0]) }));

const TENANT_TABLE_EXPORTS = new Set(
  tableConfigs.filter((t) => t.cfg.columns.some((c) => c.name === "organization_id") && t.exportName !== "organizationMemberships").map((t) => t.exportName),
);

/** The only files that may touch tenant tables or open a tenant transaction: the client-side halves of the handshake and the requests inbox. */
const TENANT_WRITERS = new Set(["domain/practice/consent-service.ts", "domain/client-requests/client-request-service.ts"]);

describe("practice boundary (structural) — the application-layer design cannot quietly regress", () => {
  it("found the practice source files", () => {
    expect(PRACTICE_DOMAIN.length).toBeGreaterThanOrEqual(18);
    expect(REQUEST_DOMAIN.length).toBeGreaterThanOrEqual(1);
  });

  it("never opens a connection of its own or imports a low-level database handle", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/DIRECT_DATABASE_URL|DATABASE_URL|new Pool\(|from "pg"|from 'pg'/.test(code), `${rel(file)} opens its own connection`).toBe(false);
      for (const imp of importsOf(code)) {
        expect(imp.from, `${rel(file)} imports the raw db client`).not.toBe("@/db/client");
        expect(imp.from, `${rel(file)} imports db connection plumbing`).not.toBe("@/db/connection");
        expect(imp.from, `${rel(file)} imports the migration runner`).not.toBe("@/db/migrate");
        if (imp.from === "@/db/tenant") expect(imp.names.every((n) => ["withTenant", "TenantDb"].includes(n)), `${rel(file)}: ${imp.names}`).toBe(true);
        if (imp.from === "@/db/user-scope") expect(imp.names.every((n) => ["withUserScope", "UserScopeDb"].includes(n)), `${rel(file)}: ${imp.names}`).toBe(true);
      }
    }
  });

  it("never uses raw SQL with a session variable or a role switch, and never sets a scope variable itself", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/set_config|current_setting|app\.current_(org|user|practice)_id|SECURITY DEFINER|SET ROLE|SET SESSION AUTHORIZATION/i.test(code), `${rel(file)} touches session scope`).toBe(false);
    }
  });

  it("never fans out in parallel: no Promise.all / allSettled / race / any anywhere in the practice modules, pages or actions", () => {
    for (const file of ALL_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/Promise\s*\.\s*(all|allSettled|race|any)\b/.test(code), `${rel(file)} fans out`).toBe(false);
    }
  });

  it("opens tenant transactions only in the two client-side services (consent record, requests inbox)", () => {
    for (const file of DOMAIN_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/withTenant\(/.test(code)) {
        expect(TENANT_WRITERS.has(rel(file)), `${rel(file)} opens a tenant transaction`).toBe(true);
      }
    }
  });

  it("imports no tenant table outside those two services: every other read of a client goes through that client's own services with a per-client Actor", () => {
    expect(TENANT_TABLE_EXPORTS.size).toBeGreaterThan(20);
    for (const file of ALL_FILES) {
      if (TENANT_WRITERS.has(rel(file))) continue;
      for (const imp of importsOf(stripComments(readFileSync(file, "utf8")))) {
        if (imp.from !== "@/db/schema") continue;
        for (const name of imp.names) expect(TENANT_TABLE_EXPORTS.has(name), `${rel(file)} imports tenant table ${name}`).toBe(false);
      }
    }
  });

  it("the client-data readers reach the client only through the real per-client services and the consent gate", () => {
    const health = readFileSync(path.join(ROOT, "domain/practice/health-service.ts"), "utf8");
    for (const needle of ["CloseChecklistService.compute", "ReconciliationService.getSummary", "PayRunService.countDrafts", "PeriodCloseService.getTaxLockedThrough", "PracticeConsentService.statusFor", "OrganizationService.getMembership", "roleHasPermission"]) {
      expect(health, needle).toContain(needle);
    }
    const wp = readFileSync(path.join(ROOT, "domain/practice/workpaper-service.ts"), "utf8");
    expect(wp).toContain("requireClientActor");
    expect(wp).toContain("LedgerService.getAccountBalance");
    expect(wp).toContain('assertPermission(clientActor, "financial_report:read")');
    expect(wp).toContain('assertPermission(clientActor, "journal:read")');
    const access = readFileSync(path.join(ROOT, "domain/practice/client-access.ts"), "utf8");
    expect(access).toContain("OrganizationService.getMembership");
    expect(access).toContain("PracticeConsentService.assertActive");
    // Order matters: membership first, consent immediately before the read.
    expect(access.indexOf("getMembership")).toBeLessThan(access.indexOf("assertActive"));
  });

  it("workpapers and practice services have no way to write a client's ledger: no posting, journal, reversal or period-lock service is imported", () => {
    for (const file of PRACTICE_DOMAIN) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/PostingService|\.postJournal|reverseEntry|PeriodLockService|PeriodCloseService\.(close|signOff|revokeSignOff)|createJournalFromTransaction|BankImportService|InvoiceService/.test(code), `${rel(file)} could write the client ledger`).toBe(false);
    }
    // The one ledger import is the read-only balance query.
    const ledgerImports = PRACTICE_DOMAIN.flatMap((f) => importsOf(stripComments(readFileSync(f, "utf8"))).filter((i) => i.from.startsWith("@/domain/ledger")).map((i) => `${rel(f)}:${i.from}:${i.names.join(",")}`));
    expect(ledgerImports).toEqual(["domain/practice/workpaper-service.ts:@/domain/ledger/ledger-service:LedgerService"]);
  });

  it("no practice module calls an AI autonomy path: practice features are human-only", () => {
    for (const file of DOMAIN_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(/autonomy|AutoExecution|draft-proposal|executeDraft/i.test(code), `${rel(file)} touches AI autonomy`).toBe(false);
    }
  });

  it("practice tables carry a practice_id (or are the root) and never organization_id or owner_user_id; the client-visible tables are tenant tables", () => {
    const practiceExports = ["practices", "practicePartners", "practiceMembers", "practiceRoster", "practiceAuditLogs", "practiceClientLinks", "practiceClientGroups", "practiceClientGroupMembers", "clientHealthSnapshots", "practiceDeadlineTemplates", "practiceTasks", "workpapers", "workpaperSnapshots", "workpaperScheduleLines", "workpaperEvidence", "workpaperAdjustments", "workpaperReviewNotes", "workpaperSignoffs"];
    for (const name of practiceExports) {
      const t = tableConfigs.find((x) => x.exportName === name)!;
      const cols = t.cfg.columns.map((c) => c.name);
      expect(cols, name).not.toContain("organization_id");
      expect(cols, name).not.toContain("owner_user_id");
      if (name !== "practices") expect(cols, name).toContain("practice_id");
    }
    for (const name of ["practiceClientConsents", "clientRequests", "clientRequestMessages"]) {
      const t = tableConfigs.find((x) => x.exportName === name)!;
      expect(t.cfg.columns.map((c) => c.name), name).toContain("organization_id");
    }
  });

  it("the RLS migration adds no bypass: no SECURITY DEFINER, no function, no BYPASSRLS, no multi-valued predicate; FORCE and a policy on every table", () => {
    const sql = readFileSync(path.join(REPO, "drizzle/0041_practice_slice5_row_level_security.sql"), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(/security\s+definer|bypassrls|set\s+role|create\s+(or\s+replace\s+)?function|create\s+trigger/i.test(code)).toBe(false);
    expect(/\bany\s*\(|string_to_array|unnest|array\s*\[|\bin\s*\(\s*select/i.test(code)).toBe(false);
    const tables = [...code.matchAll(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g)].map((m) => m[1]!);
    expect(tables.length).toBe(21); // 18 practice tables + 3 client-side tables
    for (const t of tables) {
      expect(code, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(code, t).toMatch(new RegExp(`CREATE POLICY \\w+ ON ${t}\\b`));
    }
    const policies = code.split("CREATE POLICY").slice(1);
    for (const p of policies) {
      const table = /^\s*\w+ ON (\w+)/.exec(p)![1]!;
      const onTenant = ["practice_client_consents", "client_requests", "client_request_messages"].includes(table);
      if (onTenant) {
        expect(p).toContain("app.current_org_id");
        expect(p).not.toContain("app.current_user_id");
      } else {
        expect(p).toContain("app.current_user_id");
        expect(p).not.toContain("app.current_org_id");
      }
    }
    // The append-only tables are granted SELECT + INSERT and nothing else.
    for (const t of ["practice_audit_logs", "workpaper_snapshots", "workpaper_signoffs", "client_request_messages"]) {
      expect(code).toContain(`GRANT SELECT, INSERT ON ${t} TO mm_app;`);
    }
    // Review-note text is immutable: only the resolution columns are updatable.
    expect(code).toContain("GRANT UPDATE (status, resolved_by_user_id, resolved_at, resolution_comment) ON workpaper_review_notes TO mm_app;");
    // Nothing practice-side is ever deletable except the dedicated, listed tables.
    const deletable = [...code.matchAll(/GRANT [A-Z, ]*DELETE[A-Z, ]* ON (\w+) TO mm_app/g)].map((m) => m[1]!).sort();
    expect(deletable).toEqual(["practice_client_group_members", "practice_client_groups", "practice_partners", "workpaper_evidence", "workpaper_schedule_lines"]);
  });

  it("every practice page, route and server action resolves the current user (no unauthenticated path)", () => {
    const gated = UI_FILES.filter((f) => /(page|actions|route)\.tsx?$/.test(f));
    for (const file of gated) {
      expect(/getCurrentUser|requirePracticeUser|requireCurrentPractice|requireOrgAndActor|getActorForOrganization/.test(readFileSync(file, "utf8")), `${rel(file)} lacks an authentication check`).toBe(true);
    }
  });
});
