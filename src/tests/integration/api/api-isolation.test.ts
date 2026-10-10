import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { get, makeKey, resetApiThrottle } from "../../helpers/api";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { apiIdempotencyKeys, apiKeys } from "@/db/schema";
import { evaluateIsolation, loadTableSecurityRows, RLS_EXEMPT_TABLES } from "@/db/isolation-audit";
import { hashApiKey } from "@/domain/api/api-key-format";

describe("API tables: tenant isolation and the lookup index's restricted grants", () => {
  let a: Awaited<ReturnType<typeof createTestOrg>>;
  let b: Awaited<ReturnType<typeof createTestOrg>>;
  let keyA: { id: string; prefix: string; secret: string };
  let keyB: { id: string; prefix: string; secret: string };
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
  // The REAL restricted application role, used with hand-written SQL to prove what the database itself refuses.
  const app = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    a = await createTestOrg("api-iso-a");
    b = await createTestOrg("api-iso-b");
    keyA = await makeKey(a.owner, ["contacts:read"]);
    keyB = await makeKey(b.owner, ["contacts:read"]);
  });

  afterAll(async () => {
    await admin.end();
    await app.end();
    await closeTestPools();
  });

  /** Runs SQL as mm_app inside a transaction scoped to `orgId` (or unscoped when null). */
  async function asApp<T>(orgId: string | null, fn: (q: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      if (orgId) await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      return await fn((text, values) => client.query(text, values));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  describe("api_keys and api_idempotency_keys are ordinary RLS-protected tenant tables", () => {
    it("have RLS enabled AND forced, a single-variable policy, and pass the structural isolation audit", async () => {
      const rows = await loadTableSecurityRows(admin);
      const result = evaluateIsolation(rows);
      expect(result.problems).toEqual([]);
      for (const name of ["api_keys", "api_idempotency_keys"]) {
        const t = rows.find((r) => r.table_name === name)!;
        expect(t.tenant_scoped, name).toBe(true);
        expect(t.rls_enabled && t.rls_forced, name).toBe(true);
        expect(Number(t.policies), name).toBeGreaterThan(0);
        expect(t.app_can_select, name).toBe(true);
        for (const expr of t.policy_exprs) {
          expect(expr).toContain("app.current_org_id");
          expect(expr).not.toContain("app.current_user_id");
        }
      }
    });

    it("an organization sees only its own keys and idempotency rows, even with no WHERE clause; no tenant context sees nothing", async () => {
      const own = await withTenant(a.organizationId, (tx) => tx.select().from(apiKeys));
      expect(own.map((k) => k.id)).toEqual([keyA.id]);
      const theirs = await withTenant(b.organizationId, (tx) => tx.select().from(apiKeys));
      expect(theirs.map((k) => k.id)).toEqual([keyB.id]);
      expect(await asApp(null, async (q) => (await q("SELECT * FROM api_keys")).rows)).toEqual([]);
      expect(await asApp(null, async (q) => (await q("SELECT * FROM api_idempotency_keys")).rows)).toEqual([]);

      // Seed an idempotency row for A through the superuser, then look from B.
      await admin.query("INSERT INTO api_idempotency_keys (organization_id, api_key_id, idempotency_key, request_hash) VALUES ($1, $2, 'k', 'h')", [a.organizationId, keyA.id]);
      expect(await withTenant(a.organizationId, (tx) => tx.select().from(apiIdempotencyKeys))).toHaveLength(1);
      expect(await withTenant(b.organizationId, (tx) => tx.select().from(apiIdempotencyKeys))).toHaveLength(0);
    });

    it("RLS refuses writing a row for a different organization than the one scoped on the connection", async () => {
      const msg = await pgMessage(
        withTenant(a.organizationId, (tx) =>
          tx.execute(sql`INSERT INTO api_keys (organization_id, name, prefix, scopes, created_by_user_id) VALUES (${b.organizationId}, 'forged', 'forged01', ARRAY['contacts:read'], ${a.owner.userId})`),
        ),
      );
      expect(msg).toMatch(/row-level security/i);
      expect(await withTenant(b.organizationId, (tx) => tx.select().from(apiKeys))).toHaveLength(1);
    });

    it("can neither delete keys nor edit anything but the revocation columns (column-level grants)", async () => {
      await asApp(a.organizationId, async (q) => {
        await expect(q("DELETE FROM api_keys")).rejects.toThrow(/permission denied/i);
      });
      await asApp(a.organizationId, async (q) => {
        await expect(q("UPDATE api_keys SET name = 'renamed'")).rejects.toThrow(/permission denied/i);
      });
      await asApp(a.organizationId, async (q) => {
        await expect(q("UPDATE api_keys SET scopes = ARRAY['reports:read']")).rejects.toThrow(/permission denied/i);
      });
      // Revoking one's OWN key is allowed; another organization's row is simply not visible to update.
      await asApp(a.organizationId, async (q) => {
        expect((await q("UPDATE api_keys SET revoked_at = now()")).rowCount).toBe(1);
      });
      await asApp(b.organizationId, async (q) => {
        expect((await q("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [keyA.id])).rowCount).toBe(0);
      });
    });
  });

  describe("api_key_index: the narrow non-tenant lookup", () => {
    it("is the one exempt table, holds only authentication facts, and no financial or personal data", async () => {
      expect(RLS_EXEMPT_TABLES.has("api_key_index")).toBe(true);
      const cols = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'api_key_index' ORDER BY column_name");
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "created_at",
        "created_by_user_id",
        "expires_at",
        "id",
        "last_used_at",
        "organization_id",
        "prefix",
        "rate_limit_per_minute",
        "revoked_at",
        "scopes",
        "secret_hash",
      ]);
      const counters = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'api_rate_windows' ORDER BY column_name");
      expect(counters.rows.map((r) => r.column_name)).toEqual(["key_id", "request_count", "window_start"]);
    });

    it("mm_app can read it and insert into it, but never delete, truncate or rewrite its hash, prefix, organization, creator or scopes", async () => {
      await asApp(null, async (q) => {
        expect((await q("SELECT id FROM api_key_index")).rows.length).toBe(2); // by design: the lookup is not tenant-scoped
      });
      for (const stmt of [
        "DELETE FROM api_key_index",
        "TRUNCATE api_key_index",
        "UPDATE api_key_index SET secret_hash = 'x'",
        "UPDATE api_key_index SET prefix = 'zzzzzzzz'",
        "UPDATE api_key_index SET organization_id = gen_random_uuid()",
        "UPDATE api_key_index SET created_by_user_id = gen_random_uuid()",
        "UPDATE api_key_index SET scopes = ARRAY['reports:read']",
        "UPDATE api_key_index SET expires_at = NULL",
        "UPDATE api_key_index SET rate_limit_per_minute = 600",
        "DELETE FROM api_rate_windows",
        "TRUNCATE api_rate_windows",
      ]) {
        await asApp(a.organizationId, async (q) => {
          await expect(q(stmt), stmt).rejects.toThrow(/permission denied/i);
        });
      }
      await asApp(a.organizationId, async (q) => {
        expect((await q("UPDATE api_key_index SET revoked_at = now(), last_used_at = now() WHERE id = $1", [keyA.id])).rowCount).toBe(1);
      });
    });

    it("an index row for another organization's key cannot be forged from inside a tenant transaction (composite FK to the RLS-protected api_keys)", async () => {
      const fakeSecret = "mm_live_forgedxx_" + "A".repeat(43);
      const attempts: Array<[string, unknown[]]> = [
        // a brand-new id for B's organization
        [`INSERT INTO api_key_index (id, organization_id, prefix, secret_hash, created_by_user_id, scopes) VALUES (gen_random_uuid(), $1, 'forgedxx', $2, $3, ARRAY['invoices:write'])`, [b.organizationId, hashApiKey(fakeSecret), b.owner.userId]],
        // org A's real key id, claimed for org B
        [`INSERT INTO api_key_index (id, organization_id, prefix, secret_hash, created_by_user_id, scopes) VALUES ($4, $1, 'forgedyy', $2, $3, ARRAY['invoices:write'])`, [b.organizationId, hashApiKey(fakeSecret), b.owner.userId, keyA.id]],
      ];
      for (const [text, values] of attempts) {
        await asApp(a.organizationId, async (q) => {
          await expect(q(text, values)).rejects.toThrow(/foreign key|violates/i);
        });
      }
      // Nor can A first create the missing api_keys row for B (RLS WITH CHECK).
      await asApp(a.organizationId, async (q) => {
        await expect(
          q(`INSERT INTO api_keys (id, organization_id, name, prefix, scopes, created_by_user_id) VALUES (gen_random_uuid(), $1, 'x', 'forgedzz', ARRAY['invoices:write'], $2)`, [b.organizationId, b.owner.userId]),
        ).rejects.toThrow(/row-level security/i);
      });
      expect((await admin.query("SELECT count(*)::int AS n FROM api_key_index")).rows[0].n).toBe(2);
      // And the forged secret does not authenticate.
      expect((await get("/me", fakeSecret)).status).toBe(401);
    });

    it("exposes nothing usable: the stored value is a hash of the key, and presenting the hash (or the prefix) authenticates nothing", async () => {
      const { rows } = await admin.query("SELECT secret_hash, prefix FROM api_key_index WHERE id = $1", [keyA.id]);
      expect(rows[0].secret_hash).toBe(hashApiKey(keyA.secret));
      expect(rows[0].secret_hash).not.toContain(keyA.secret.slice(-43));
      for (const presented of [rows[0].secret_hash, rows[0].prefix, `mm_live_${rows[0].prefix}_${rows[0].secret_hash}`, `mm_live_${rows[0].prefix}_${rows[0].secret_hash.slice(0, 43)}`]) {
        expect((await get("/me", presented)).status, presented).toBe(401);
      }
    });

    it("the key still resolves only to ITS organization: org A's key cannot see org B's data, and vice versa", async () => {
      const aMe = await get("/me", keyA.secret);
      const bMe = await get("/me", keyB.secret);
      expect(aMe.body.data.organization_id).toBe(a.organizationId);
      expect(bMe.body.data.organization_id).toBe(b.organizationId);
      expect(aMe.text).not.toContain(b.organizationId);
    });
  });

  it("the database refuses everything the audit says it must when queried unscoped (no policy bypass was added)", async () => {
    await asApp(null, async (q) => {
      for (const table of ["invoices", "contacts", "accounts", "audit_logs", "journal_entries", "api_keys", "api_idempotency_keys"]) {
        expect((await q(`SELECT 1 FROM ${table}`)).rows, table).toEqual([]);
      }
    });
    const role = await db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toMatchObject({ rolbypassrls: false, rolsuper: false });
  });
});
