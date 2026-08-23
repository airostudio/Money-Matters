import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeTestPools, createTestOrg, resetDatabase } from "../helpers/db";
import { createSampleAccounts } from "../helpers/ledger";
import { accounts, auditLogs } from "@/db/schema";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { AccountService } from "@/domain/accounts/account-service";
import { PostingService } from "@/domain/ledger/posting-service";

/**
 * Master spec §48 / §87 non-negotiable #7: "A coding mistake must not allow
 * Company A to retrieve Company B's data." These tests deliberately mimic
 * an application-layer mistake — a query that forgets its organizationId
 * filter — and confirm the Row-Level Security backstop (see
 * drizzle/0001_row_level_security.sql, docs/security.md §2) still prevents
 * cross-tenant reads and writes, so isolation does not depend solely on
 * every service method remembering to filter correctly.
 */
describe("Tenant isolation", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let orgA: Awaited<ReturnType<typeof createTestOrg>>;
  let orgB: Awaited<ReturnType<typeof createTestOrg>>;
  let orgAAccountIds: string[];
  let orgBAccountIds: string[];
  let orgAAccountId: string;
  let orgBAccountId: string;

  beforeEach(async () => {
    await resetDatabase();
    orgA = await createTestOrg("tenant-a");
    orgB = await createTestOrg("tenant-b");
    orgAAccountIds = await createSampleAccounts(orgA.owner, orgA.baseCurrency);
    orgBAccountIds = await createSampleAccounts(orgB.owner, orgB.baseCurrency);
    orgAAccountId = orgAAccountIds[0]!;
    orgBAccountId = orgBAccountIds[0]!;

    await PostingService.postJournal(orgA.owner, {
      postingDate: new Date(),
      lines: [
        { accountId: orgAAccountId, debit: "42.00", currency: "AUD" },
        { accountId: orgAAccountIds[1]!, credit: "42.00", currency: "AUD" },
      ],
    });
  });

  it("RLS blocks a query with NO tenant context set at all, even for real rows", async () => {
    // Simulates a code path that queries the shared `db` client directly
    // instead of going through withTenant() — app.current_org_id is unset.
    const rows = await db.select().from(accounts);
    expect(rows).toHaveLength(0);
  });

  it("RLS returns only the scoped org's rows even when the query itself has no WHERE filter", async () => {
    const rowsAsOrgA = await withTenant(orgA.organizationId, (tx) => tx.select().from(accounts));
    expect(rowsAsOrgA.every((r) => r.organizationId === orgA.organizationId)).toBe(true);
    expect(rowsAsOrgA.some((r) => r.id === orgBAccountId)).toBe(false);

    const rowsAsOrgB = await withTenant(orgB.organizationId, (tx) => tx.select().from(accounts));
    expect(rowsAsOrgB.every((r) => r.organizationId === orgB.organizationId)).toBe(true);
    expect(rowsAsOrgB.some((r) => r.id === orgAAccountId)).toBe(false);
  });

  it("RLS protects the append-only audit log the same way", async () => {
    const rowsAsOrgA = await withTenant(orgA.organizationId, (tx) => tx.select().from(auditLogs));
    expect(rowsAsOrgA.length).toBeGreaterThan(0);
    expect(rowsAsOrgA.every((r) => r.organizationId === orgA.organizationId)).toBe(true);
  });

  it("domain service layer also refuses to serve another org's resource by id", async () => {
    const result = await AccountService.get(orgA.owner, orgBAccountId);
    expect(result).toBeNull();
  });

  it("rejects posting a journal line against another org's account even with a valid actor", async () => {
    await expect(
      PostingService.postJournal(orgA.owner, {
        postingDate: new Date(),
        lines: [
          { accountId: orgBAccountId, debit: "10.00", currency: "AUD" },
          { accountId: orgAAccountIds[2]!, credit: "10.00", currency: "AUD" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("every tenant table has RLS both ENABLED and FORCED", async () => {
    // FORCE matters separately from ENABLE: PostgreSQL exempts a table's
    // OWNER from its own row-level security unless FORCE is set. Without it,
    // pointing the app's connection at the migration/admin role silently
    // disables tenant isolation while appearing to work — see
    // drizzle/0002_force_row_level_security.sql.
    const tenantTables = [
      "accounts",
      "fiscal_periods",
      "exchange_rates",
      "tax_codes",
      "contacts",
      "dimensions",
      "dimension_values",
      "journal_line_dimensions",
      "approvals",
      "journal_entries",
      "journal_lines",
      "audit_logs",
    ];

    const rows = await db.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    `);

    const byName = new Map(rows.rows.map((r) => [r.relname, r]));
    for (const table of tenantTables) {
      const row = byName.get(table);
      expect(row, `${table} should exist`).toBeDefined();
      expect(row?.relrowsecurity, `${table} should have RLS enabled`).toBe(true);
      expect(row?.relforcerowsecurity, `${table} should have RLS forced`).toBe(true);
    }
  });

  it("RLS rejects an INSERT for an org other than the one scoped on the connection", async () => {
    await expect(
      withTenant(orgA.organizationId, (tx) =>
        tx.insert(accounts).values({
          organizationId: orgB.organizationId,
          code: "9999",
          name: "hack",
          type: "ASSET",
          currency: "AUD",
        }),
      ),
    ).rejects.toThrow();

    const leaked = await withTenant(orgB.organizationId, (tx) =>
      tx.select().from(accounts).where(eq(accounts.code, "9999")),
    );
    expect(leaked).toHaveLength(0);
  });
});
