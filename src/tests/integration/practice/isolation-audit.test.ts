import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { evaluateIsolation, loadTableSecurityRows } from "@/db/isolation-audit";
import { closeTestPools } from "../../helpers/db";

const PRACTICE_TABLES = [
  "client_health_snapshots",
  "practice_audit_logs",
  "practice_client_group_members",
  "practice_client_groups",
  "practice_client_links",
  "practice_deadline_templates",
  "practice_members",
  "practice_partners",
  "practice_roster",
  "practice_tasks",
  "practices",
  "workpaper_adjustments",
  "workpaper_evidence",
  "workpaper_review_notes",
  "workpaper_schedule_lines",
  "workpaper_signoffs",
  "workpaper_snapshots",
  "workpapers",
];

const NEW_TENANT_TABLES = ["client_request_messages", "client_requests", "practice_client_consents"];

describe("the real test database passes the isolation audit with the practice scoping model", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  it("every practice table is FORCEd, keyed on app.current_user_id plus an ACTIVE membership; the client-visible tables are ordinary tenant tables", async () => {
    const pool = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
    try {
      const rows = await loadTableSecurityRows(pool);
      const result = evaluateIsolation(rows);
      expect(result.problems).toEqual([]);

      const practice = rows.filter((r) => r.practice_scoped || r.table_name === "practices").map((r) => r.table_name).sort();
      expect(practice).toEqual(PRACTICE_TABLES);
      expect(result.practiceScopedCount).toBe(PRACTICE_TABLES.length);

      for (const t of rows.filter((r) => PRACTICE_TABLES.includes(r.table_name))) {
        expect(t.rls_enabled && t.rls_forced, t.table_name).toBe(true);
        expect(t.policy_exprs.length, t.table_name).toBeGreaterThan(0);
        for (const e of t.policy_exprs) {
          expect(e, t.table_name).toContain("app.current_user_id");
          expect(e, t.table_name).not.toContain("app.current_org_id");
          if (!["practice_members", "practice_partners", "practices"].includes(t.table_name)) {
            expect(e, t.table_name).toContain("practice_members");
          }
        }
      }

      // The client-visible tables are classified as TENANT tables and keyed on the organization only.
      for (const name of NEW_TENANT_TABLES) {
        const t = rows.find((r) => r.table_name === name)!;
        expect(t.tenant_scoped, name).toBe(true);
        expect(t.practice_scoped, name).toBe(false);
        expect(t.rls_enabled && t.rls_forced, name).toBe(true);
        expect(t.policy_exprs.every((e) => e.includes("app.current_org_id") && !e.includes("app.current_user_id")), name).toBe(true);
      }

      // The consolidation (owner_user_id) model is untouched.
      expect(rows.filter((r) => r.user_scoped && !r.tenant_scoped).length).toBe(8);
    } finally {
      await pool.end();
    }
  });
});
