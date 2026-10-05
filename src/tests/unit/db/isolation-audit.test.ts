import { describe, expect, it } from "vitest";
import { evaluateIsolation, type TableSecurityRow } from "@/db/isolation-audit";

const ORG = "(organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)";
const USER = "(owner_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid)";

const row = (over: Partial<TableSecurityRow> & { table_name: string }): TableSecurityRow => ({
  tenant_scoped: false,
  user_scoped: false,
  rls_enabled: false,
  rls_forced: false,
  policies: 0,
  app_can_select: true,
  policy_exprs: [],
  ...over,
});

const goodTenant = (name = "invoices") =>
  row({ table_name: name, tenant_scoped: true, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [ORG, ORG] });
const goodUser = (name = "entity_groups") =>
  row({ table_name: name, user_scoped: true, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [USER, USER] });

describe("isolation audit rules", () => {
  it("passes a correct tenant table and a correct user-scoped table, counting each model", () => {
    const result = evaluateIsolation([goodTenant(), goodUser(), row({ table_name: "users" })]);
    expect(result.problems).toEqual([]);
    expect(result.tenantScopedCount).toBe(1);
    expect(result.userScopedCount).toBe(1);
  });

  it("flags a user-scoped table without RLS (it would be readable by every user)", () => {
    const problems = evaluateIsolation([row({ table_name: "entity_groups", user_scoped: true })]).problems;
    expect(problems.join("\n")).toMatch(/entity_groups: is user-scoped but row-level security is NOT enabled/);
  });

  it("flags a user-scoped table whose RLS is not FORCEd", () => {
    const problems = evaluateIsolation([{ ...goodUser(), rls_forced: false }]).problems;
    expect(problems.join("\n")).toMatch(/not FORCEd/);
  });

  it("flags RLS enabled with no policy on any table", () => {
    const problems = evaluateIsolation([row({ table_name: "x", rls_enabled: true, rls_forced: true })]).problems;
    expect(problems.join("\n")).toMatch(/no policy exists/);
  });

  it("flags a user-scoped policy that is not keyed on app.current_user_id (e.g. 'true' or the org variable)", () => {
    const wide = evaluateIsolation([{ ...goodUser(), policy_exprs: ["true"] }]).problems.join("\n");
    expect(wide).toMatch(/not keyed on app\.current_user_id/);
    const wrongVar = evaluateIsolation([{ ...goodUser(), policy_exprs: [ORG] }]).problems.join("\n");
    expect(wrongVar).toMatch(/not keyed on app\.current_user_id/);
    expect(wrongVar).toMatch(/references app\.current_org_id/);
  });

  it("flags a tenant policy that is not keyed on app.current_org_id, or that mixes in the user variable", () => {
    expect(evaluateIsolation([{ ...goodTenant(), policy_exprs: ["true"] }]).problems.join("\n")).toMatch(/not keyed on app\.current_org_id/);
    const mixed = `(${ORG} OR ${USER})`;
    expect(evaluateIsolation([{ ...goodTenant(), policy_exprs: [mixed] }]).problems.join("\n")).toMatch(/references app\.current_user_id/);
  });

  it("flags ANY multi-valued predicate against a session setting (a list of organizations or users), on any table", () => {
    const multiOrg = "(organization_id = ANY ((string_to_array(current_setting('app.current_org_ids'::text, true), ','::text))::uuid[]))";
    const problems = evaluateIsolation([{ ...goodTenant(), policy_exprs: [multiOrg] }]).problems.join("\n");
    expect(problems).toMatch(/multi-valued setting/);
    const onUnscoped = evaluateIsolation([row({ table_name: "currencies", rls_enabled: true, policies: 1, policy_exprs: [multiOrg] })]).problems.join("\n");
    expect(onUnscoped).toMatch(/multi-valued setting/);
  });

  it("organization_memberships stays the one documented exemption", () => {
    const m = row({ table_name: "organization_memberships", tenant_scoped: true });
    expect(evaluateIsolation([m]).problems).toEqual([]);
  });

  it("flags a table the application role cannot read", () => {
    expect(evaluateIsolation([row({ table_name: "orphan", app_can_select: false })]).problems.join("\n")).toMatch(/no SELECT grant/);
  });

  describe("practice-scoped tables (Phase 9 Slice 5)", () => {
    const ME = "(NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid";
    const MEMBER = `(EXISTS ( SELECT 1 FROM practice_members pm WHERE ((pm.practice_id = t.practice_id) AND (pm.user_id = ${ME}) AND (pm.status = 'ACTIVE'::practice_member_status))))`;
    const goodPractice = (name = "practice_tasks") =>
      row({ table_name: name, practice_scoped: true, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [MEMBER, MEMBER] });

    it("passes a table keyed on the user variable AND an ACTIVE practice membership, the gate tables and the root, counting them", () => {
      const gate = row({ table_name: "practice_members", practice_scoped: true, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [`(user_id = ${ME})`] });
      const anchor = row({ table_name: "practice_partners", practice_scoped: true, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [`(user_id = ${ME})`] });
      const root = row({ table_name: "practices", rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [`(created_by_user_id = ${ME})`] });
      const result = evaluateIsolation([goodPractice(), gate, anchor, root]);
      expect(result.problems).toEqual([]);
      expect(result.practiceScopedCount).toBe(4);
    });

    it("flags a practice table without RLS, or not FORCEd, or with no policy", () => {
      expect(evaluateIsolation([row({ table_name: "workpapers", practice_scoped: true })]).problems.join("\n")).toMatch(/practice-scoped but row-level security is NOT enabled/);
      expect(evaluateIsolation([{ ...goodPractice(), rls_forced: false }]).problems.join("\n")).toMatch(/not FORCEd/);
      expect(evaluateIsolation([row({ table_name: "workpapers", practice_scoped: true, rls_enabled: true, rls_forced: true })]).problems.join("\n")).toMatch(/no policy exists/);
    });

    it("flags a policy that lost the membership check (a bare user-variable predicate, or 'true')", () => {
      const bare = evaluateIsolation([{ ...goodPractice(), policy_exprs: [`(created_by_user_id = ${ME})`] }]).problems.join("\n");
      expect(bare).toMatch(/does not consult practice_members/);
      const open = evaluateIsolation([{ ...goodPractice(), policy_exprs: ["true"] }]).problems.join("\n");
      expect(open).toMatch(/not keyed on app\.current_user_id/);
    });

    it("flags a practice policy that mixes in the organization variable, or compares against a list", () => {
      const mixed = evaluateIsolation([
        { ...goodPractice(), policy_exprs: [`(${MEMBER} OR organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)`] },
      ]).problems.join("\n");
      expect(mixed).toMatch(/references app\.current_org_id/);
      const list = evaluateIsolation([
        { ...goodPractice(), policy_exprs: ["(practice_id = ANY ((string_to_array(current_setting('app.current_practice_ids'::text, true), ','::text))::uuid[]))"] },
      ]).problems.join("\n");
      expect(list).toMatch(/multi-valued setting/);
    });

    it("a table with a practice_id AND an organization_id is a tenant table (the client-side consent record), not a practice table", () => {
      const consent = row({ table_name: "practice_client_consents", tenant_scoped: true, practice_scoped: false, rls_enabled: true, rls_forced: true, policies: 1, policy_exprs: [ORG, ORG] });
      const result = evaluateIsolation([consent]);
      expect(result.problems).toEqual([]);
      expect(result.practiceScopedCount).toBe(0);
      expect(result.tenantScopedCount).toBe(1);
    });
  });
});
