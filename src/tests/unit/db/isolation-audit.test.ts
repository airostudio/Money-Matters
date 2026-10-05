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
});
