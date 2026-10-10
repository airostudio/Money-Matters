import type { Pool } from "pg";

/**
 * Tables that legitimately carry `organization_id` without a tenant-isolation
 * policy.
 *
 * `organization_memberships` is the join that *answers* "which organizations
 * is this user in?", and the session has no current organization until it has
 * been answered — a policy keyed on `app.current_org_id` would make the
 * lookup that establishes the org depend on the org already being
 * established. Isolation for it is enforced in the application layer (a
 * session only ever reads its own memberships) and covered by
 * src/tests/integration/tenant-isolation.test.ts.
 *
 * `api_key_index` (Phase 10 Slice 1) is the same shape of problem: the public
 * API authenticates a key BEFORE it knows the organization (the key is what
 * identifies it), so the prefix -> organization lookup cannot be keyed on
 * `app.current_org_id`. It is bounded by column-level GRANTs instead (SELECT +
 * INSERT, UPDATE of only revoked_at/last_used_at, no DELETE), holds no
 * financial data, and a composite foreign key to the RLS-protected `api_keys`
 * stops a row for another organization's key being forged. See
 * docs/security.md section 15 and
 * src/tests/integration/api/api-key-index-grants.test.ts.
 *
 * `organization_invite_index` (organisation lifecycle slice) is the same shape again: invite redemption happens BEFORE
 * the redeemer is a member, so the code-hash -> (invite, organization) lookup cannot be keyed on
 * `app.current_org_id`. It is SELECT + INSERT only (no UPDATE, no DELETE), carries no email/role/expiry/state, and a
 * composite foreign key to the RLS-protected `organization_invites` stops a row for another organization's invite
 * being forged. See docs/security.md section 17 and src/tests/integration/organizations/invite-index.test.ts.
 */
export const RLS_EXEMPT_TABLES = new Set(["organization_memberships", "api_key_index", "organization_invite_index"]);

/**
 * The practice (accounting firm) scoping model, Phase 9 Slice 5 (docs/security.md
 * section 13). A practice table carries `practice_id` (and no `organization_id`)
 * and is isolated by the single variable `app.current_user_id` PLUS membership of
 * the practice:
 *  - the GATE tables ("practice_members", "practice_partners") are keyed on the
 *    user variable alone (own row / own partner row); they are what every other
 *    practice policy asks about, so they cannot ask about themselves;
 *  - the root "practices" table has no `practice_id` (its key is `id`) and is keyed
 *    on the user variable;
 *  - every OTHER practice table's every policy must be keyed on the user variable
 *    AND consult "practice_members" (an ACTIVE membership), so a table whose policy
 *    quietly lost the membership check is named as a problem.
 */
export const PRACTICE_ROOT_TABLES = new Set(["practices"]);
export const PRACTICE_GATE_TABLES = new Set(["practice_members", "practice_partners"]);
export const PRACTICE_MEMBERSHIP_TABLE = "practice_members";

export interface TableSecurityRow {
  table_name: string;
  /** Has an `organization_id` column: a tenant table, isolated by app.current_org_id. */
  tenant_scoped: boolean;
  /** Has an `owner_user_id` column (and no organization_id): a user-scoped table, isolated by app.current_user_id. */
  user_scoped: boolean;
  /** Has a `practice_id` column (and neither organization_id nor owner_user_id): isolated by practice membership under app.current_user_id. */
  practice_scoped?: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: number;
  app_can_select: boolean;
  /** Every policy's USING / WITH CHECK expression, as Postgres normalised it. */
  policy_exprs: string[];
}

export interface IsolationAuditResult {
  problems: string[];
  tenantScopedCount: number;
  userScopedCount: number;
  practiceScopedCount: number;
  tableCount: number;
}

const ORG_VAR = "app.current_org_id";
const USER_VAR = "app.current_user_id";
/** Constructs that would turn the single-id predicate into a "many ids" one. */
const MULTI_VALUE_PREDICATE = /\bany\s*\(|\ball\s*\(|string_to_array|\bunnest\b|regexp_split|array\s*\[/i;

/** The rules for one practice-scoped (or practice-root) table. */
function evaluatePracticeTable(row: TableSecurityRow): string[] {
  const problems: string[] = [];
  if (!row.rls_enabled) {
    problems.push(
      `${row.table_name}: is practice-scoped but row-level security is NOT enabled — every user can read every ` +
        `practice's rows. Add ALTER TABLE ${row.table_name} ENABLE ROW LEVEL SECURITY plus a membership policy.`,
    );
  }
  if (row.rls_enabled && !row.rls_forced) {
    problems.push(
      `${row.table_name}: row-level security is enabled but not FORCEd, so the table's owner still bypasses it. ` +
        `Add ALTER TABLE ${row.table_name} FORCE ROW LEVEL SECURITY.`,
    );
  }
  const needsMembership =
    !PRACTICE_GATE_TABLES.has(row.table_name) && !PRACTICE_ROOT_TABLES.has(row.table_name);
  for (const expr of row.policy_exprs) {
    if (!expr.includes(USER_VAR)) {
      problems.push(
        `${row.table_name}: a policy expression (${expr}) is not keyed on ${USER_VAR}. Every policy on a ` +
          `practice-scoped table must use that session variable.`,
      );
    }
    if (expr.includes(ORG_VAR)) {
      problems.push(
        `${row.table_name}: a policy expression (${expr}) references ${ORG_VAR}, which belongs to the ` +
          `tenant model — a table is isolated by exactly one scope.`,
      );
    }
    if (needsMembership && !expr.includes(PRACTICE_MEMBERSHIP_TABLE)) {
      problems.push(
        `${row.table_name}: a policy expression (${expr}) does not consult ${PRACTICE_MEMBERSHIP_TABLE}, so it ` +
          `would let any user through rather than only an ACTIVE member of the practice.`,
      );
    }
  }
  return problems;
}

/**
 * Pure evaluation of the per-table security facts, separated from the query so
 * every rule is unit-testable against hand-built rows.
 *
 * Two scoping models are checked, and a table must belong to exactly the one
 * its columns declare:
 *  - tenant tables (`organization_id`): FORCEd RLS, a policy, and every policy
 *    keyed on `app.current_org_id` ONLY;
 *  - user-scoped tables (`owner_user_id`, the consolidation-group tables):
 *    FORCEd RLS, a policy, and every policy keyed on `app.current_user_id` ONLY.
 * On top of that, NO policy anywhere may compare against a multi-valued
 * session setting — the design rule is "one scope id per transaction, never a
 * list" (docs/security.md sections 2 and 12).
 */
export function evaluateIsolation(rows: TableSecurityRow[]): IsolationAuditResult {
  const problems: string[] = [];

  for (const row of rows) {
    if (!row.app_can_select) {
      problems.push(
        `${row.table_name}: mm_app has no SELECT grant — the application cannot read it ` +
          `("permission denied for table ${row.table_name}"). Add a GRANT in a migration.`,
      );
    }

    // RLS enabled with zero policies denies every row to every non-owner
    // role, scoped table or not. This app relies on GRANTs alone for
    // non-scoped tables (users, organizations, organization_memberships,
    // currencies — see drizzle/0001's own comment), so nothing should ever
    // enable RLS on them; the most likely cause in practice is Supabase's
    // dashboard "Enable RLS" prompt being clicked on a table without a
    // policy being added, which fails every insert/update with no build-time
    // signal unless this check runs unconditionally on every table.
    if (row.rls_enabled && Number(row.policies) === 0) {
      problems.push(
        `${row.table_name}: row-level security is enabled but no policy exists, so the ` +
          `table denies everything to mm_app ("new row violates row-level security policy"). ` +
          `Add a policy, or if this table isn't meant to have RLS at all, ` +
          `ALTER TABLE ${row.table_name} DISABLE ROW LEVEL SECURITY.`,
      );
    }

    for (const expr of row.policy_exprs) {
      if (/current_setting/i.test(expr) && MULTI_VALUE_PREDICATE.test(expr)) {
        problems.push(
          `${row.table_name}: a policy compares against a multi-valued setting (${expr}). ` +
            `Isolation is one scope id per transaction — never a list of organizations or users.`,
        );
      }
    }

    const practice =
      !row.tenant_scoped &&
      !row.user_scoped &&
      (Boolean(row.practice_scoped) || PRACTICE_ROOT_TABLES.has(row.table_name));
    if (practice) {
      problems.push(...evaluatePracticeTable(row));
      continue;
    }

    const tenant = row.tenant_scoped && !RLS_EXEMPT_TABLES.has(row.table_name);
    const user = row.user_scoped && !row.tenant_scoped;
    if (!tenant && !user) continue;

    const scopeName = tenant ? "organization" : "user";
    if (!row.rls_enabled) {
      problems.push(
        `${row.table_name}: is ${scopeName}-scoped but row-level security is NOT enabled — ` +
          `every ${scopeName === "organization" ? "organization" : "user"} can read every other's rows. Add ` +
          `ALTER TABLE ${row.table_name} ENABLE ROW LEVEL SECURITY plus a policy.`,
      );
    }
    if (row.rls_enabled && !row.rls_forced) {
      problems.push(
        `${row.table_name}: row-level security is enabled but not FORCEd, so the table's ` +
          `owner still bypasses it. Add ALTER TABLE ${row.table_name} FORCE ROW LEVEL SECURITY.`,
      );
    }

    const mustUse = tenant ? ORG_VAR : USER_VAR;
    const mustNotUse = tenant ? USER_VAR : ORG_VAR;
    for (const expr of row.policy_exprs) {
      if (!expr.includes(mustUse)) {
        problems.push(
          `${row.table_name}: a policy expression (${expr}) is not keyed on ${mustUse}. ` +
            `Every policy on a ${scopeName}-scoped table must use that session variable.`,
        );
      }
      if (expr.includes(mustNotUse)) {
        problems.push(
          `${row.table_name}: a policy expression (${expr}) references ${mustNotUse}, ` +
            `which belongs to the other scoping model — a table is isolated by exactly one scope.`,
        );
      }
    }
  }

  return {
    problems,
    tenantScopedCount: rows.filter((r) => r.tenant_scoped && !RLS_EXEMPT_TABLES.has(r.table_name)).length,
    userScopedCount: rows.filter((r) => r.user_scoped && !r.tenant_scoped).length,
    practiceScopedCount: rows.filter(
      (r) => !r.tenant_scoped && !r.user_scoped && (Boolean(r.practice_scoped) || PRACTICE_ROOT_TABLES.has(r.table_name)),
    ).length,
    tableCount: rows.length,
  };
}

/** Reads the per-table security facts straight from the catalog. */
export async function loadTableSecurityRows(pool: Pick<Pool, "query">): Promise<TableSecurityRow[]> {
  const { rows } = await pool.query<TableSecurityRow>(`
    SELECT c.relname AS table_name,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
               AND NOT a.attisdropped
           ) AS tenant_scoped,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'owner_user_id' AND a.attnum > 0
               AND NOT a.attisdropped
           ) AS user_scoped,
           (
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'practice_id' AND a.attnum > 0
                 AND NOT a.attisdropped
             )
             AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname IN ('organization_id', 'owner_user_id') AND a.attnum > 0
                 AND NOT a.attisdropped
             )
           ) AS practice_scoped,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
           has_table_privilege('mm_app', c.oid, 'SELECT') AS app_can_select,
           COALESCE((
             SELECT array_agg(e) FROM (
               SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS e
               FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polqual IS NOT NULL
               UNION ALL
               SELECT pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
               FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polwithcheck IS NOT NULL
             ) x
           ), ARRAY[]::text[]) AS policy_exprs
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_\\_%'
    ORDER BY c.relname
  `);
  return rows;
}

/**
 * Audits every table for the properties tenant AND user-scope isolation
 * actually rest on, rather than trusting that migrations were kept in step
 * with the schema.
 *
 * Adding a table is a one-line change in src/db/schema.ts; giving it an RLS
 * policy, FORCE, and an mm_app grant is three separate edits in a different
 * file. Forgetting any of them produces no error — just a table that is either
 * invisible to the application (missing grant) or visible to every tenant at
 * once (missing policy). Both deserve to be named in the build log the first
 * time they happen, not discovered later.
 */
export async function auditTableSecurity(pool: Pick<Pool, "query">): Promise<void> {
  const rows = await loadTableSecurityRows(pool);
  const result = evaluateIsolation(rows);

  if (result.problems.length === 0) {
    console.log(
      `[db] Tenant isolation audit: ${result.tenantScopedCount} organization-scoped and ` +
        `${result.userScopedCount} user-scoped and ${result.practiceScopedCount} practice-scoped tables ` +
        `(of ${result.tableCount}), and all have FORCEd row-level security with a policy keyed on their own ` +
        `single scope variable (practice tables: ${USER_VAR} plus an ACTIVE practice membership).`,
    );
    return;
  }

  console.warn("\n[db] WARNING: tenant isolation audit found problems.");
  for (const problem of result.problems) {
    console.warn(`     - ${problem}`);
  }
  console.warn("");
}
