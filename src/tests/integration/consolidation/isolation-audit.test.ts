import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { RLS_EXEMPT_TABLES, evaluateIsolation, loadTableSecurityRows } from "@/db/isolation-audit";
import { closeTestPools } from "../../helpers/db";

describe("the real test database passes the isolation audit under BOTH scoping models", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  it("every tenant table and every user-scoped table has FORCEd RLS keyed on its own single scope variable", async () => {
    const pool = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
    try {
      const rows = await loadTableSecurityRows(pool);
      const result = evaluateIsolation(rows);
      expect(result.problems).toEqual([]);

      const userScoped = rows.filter((r) => r.user_scoped && !r.tenant_scoped).map((r) => r.table_name).sort();
      expect(userScoped).toEqual([
        "entity_group_account_mappings",
        "entity_group_accounts",
        "entity_group_adjustment_lines",
        "entity_group_adjustments",
        "entity_group_audit_logs",
        "entity_group_intercompany_accounts",
        "entity_group_members",
        "entity_groups",
      ]);
      for (const t of rows.filter((r) => userScoped.includes(r.table_name))) {
        expect(t.rls_enabled && t.rls_forced, t.table_name).toBe(true);
        expect(t.policy_exprs.length, t.table_name).toBeGreaterThan(0);
        expect(t.policy_exprs.every((e) => e.includes("app.current_user_id") && !e.includes("app.current_org_id")), t.table_name).toBe(true);
      }
      // The tenant model is unchanged: still no tenant policy mentions the user variable.
      for (const t of rows.filter((r) => r.tenant_scoped && !RLS_EXEMPT_TABLES.has(r.table_name))) {
        expect(t.policy_exprs.every((e) => e.includes("app.current_org_id") && !e.includes("app.current_user_id")), t.table_name).toBe(true);
      }
      // The exempt lookup indexes (pre-tenant reads) may carry an open SELECT policy (oauth_*: write-bound, see migration 0051),
      // but no policy anywhere on them may mention the USER variable.
      for (const t of rows.filter((r) => RLS_EXEMPT_TABLES.has(r.table_name))) {
        expect(t.policy_exprs.every((e) => !e.includes("app.current_user_id")), t.table_name).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
