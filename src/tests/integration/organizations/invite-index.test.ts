import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { evaluateIsolation, loadTableSecurityRows, RLS_EXEMPT_TABLES } from "@/db/isolation-audit";
import { InviteService } from "@/domain/organizations/invite-service";
import { hashInviteCode } from "@/domain/organizations/invite-code";

/**
 * Tenant isolation for the new tenant table (`organization_invites`) and the grants on the narrow non-tenant lookup
 * (`organization_invite_index`) that lets a not-yet-member find an invite by code hash. Everything here is asserted
 * against the REAL restricted application role (mm_app) with hand-written SQL, i.e. what the database itself enforces.
 */
describe("organization_invites (tenant table) and organization_invite_index (the narrow lookup)", () => {
  let a: Awaited<ReturnType<typeof createTestOrg>>;
  let b: Awaited<ReturnType<typeof createTestOrg>>;
  let inviteA: { id: string; code: string };
  let inviteB: { id: string; code: string };
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
  const app = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  beforeEach(async () => {
    await resetDatabase();
    a = await createTestOrg("inv-iso-a");
    b = await createTestOrg("inv-iso-b");
    const ia = await InviteService.create(a.owner, { email: "ann@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
    const ib = await InviteService.create(b.owner, { email: "bob@example.test", role: "READ_ONLY" }, { confirmWriteAccess: false });
    inviteA = { id: ia.invite.id, code: ia.code };
    inviteB = { id: ib.invite.id, code: ib.code };
  });

  afterAll(async () => {
    await admin.end();
    await app.end();
    await closeTestPools();
  });

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

  describe("organization_invites: an ordinary RLS-protected tenant table", () => {
    it("has RLS enabled AND forced, a single-variable policy, mm_app access, and passes the structural isolation audit", async () => {
      const rows = await loadTableSecurityRows(admin);
      expect(evaluateIsolation(rows).problems).toEqual([]);
      const t = rows.find((r) => r.table_name === "organization_invites")!;
      expect(t.tenant_scoped).toBe(true);
      expect(t.rls_enabled && t.rls_forced).toBe(true);
      expect(Number(t.policies)).toBeGreaterThan(0);
      expect(t.app_can_select).toBe(true);
      for (const expr of t.policy_exprs) expect(expr).toContain("app.current_org_id");
      expect(RLS_EXEMPT_TABLES.has("organization_invites")).toBe(false);
    });

    it("shows each organization only its own invites; no scope means no rows; cross-organization writes are refused", async () => {
      await asApp(a.organizationId, async (q) => {
        expect((await q("SELECT id FROM organization_invites")).rows.map((r) => r.id)).toEqual([inviteA.id]);
        expect((await q("SELECT id FROM organization_invites WHERE id = $1", [inviteB.id])).rows).toEqual([]);
        // An UPDATE aimed at B's row touches nothing.
        expect((await q("UPDATE organization_invites SET revoked_at = now() WHERE id = $1", [inviteB.id])).rowCount).toBe(0);
        await expect(
          q(
            `INSERT INTO organization_invites (organization_id, email, role, code_prefix, invited_by_user_id, expires_at) VALUES ($1, 'x@example.test', 'READ_ONLY', 'mmj_xxxxxx', $2, now() + interval '1 day')`,
            [b.organizationId, a.owner.userId],
          ),
        ).rejects.toThrow(/row-level security/i);
      });
      await asApp(null, async (q) => {
        expect((await q("SELECT id FROM organization_invites")).rows).toEqual([]);
      });
    });

    it("mm_app can revoke/mark-used an invite but never delete, truncate, or rewrite its email, role, expiry, organization or prefix", async () => {
      for (const stmt of [
        "DELETE FROM organization_invites",
        "TRUNCATE organization_invites",
        "UPDATE organization_invites SET email = 'evil@example.test'",
        "UPDATE organization_invites SET role = 'OWNER'",
        "UPDATE organization_invites SET expires_at = now() + interval '10 years'",
        "UPDATE organization_invites SET organization_id = gen_random_uuid()",
        "UPDATE organization_invites SET code_prefix = 'mmj_zzzzzz'",
        "UPDATE organization_invites SET invited_by_user_id = gen_random_uuid()",
      ]) {
        await asApp(a.organizationId, async (q) => {
          await expect(q(stmt), stmt).rejects.toThrow(/permission denied/i);
        });
      }
      await asApp(a.organizationId, async (q) => {
        expect((await q("UPDATE organization_invites SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1", [inviteA.id, a.owner.userId])).rowCount).toBe(1);
      });
    });

    it("never stores the code: not in the invite row, not in the index, only its SHA-256 in the index", async () => {
      const row = (await admin.query("SELECT * FROM organization_invites WHERE id = $1", [inviteA.id])).rows[0];
      expect(JSON.stringify(row)).not.toContain(inviteA.code);
      expect(JSON.stringify(row)).not.toContain(hashInviteCode(inviteA.code));
      const idx = (await admin.query("SELECT * FROM organization_invite_index WHERE id = $1", [inviteA.id])).rows[0];
      expect(idx.code_hash).toBe(hashInviteCode(inviteA.code));
      expect(JSON.stringify(idx)).not.toContain(inviteA.code);
    });
  });

  describe("organization_invite_index: the narrow non-tenant lookup", () => {
    it("is exempt from RLS, holds only code hash -> (invite, organization), and no email, role, expiry or state", async () => {
      expect(RLS_EXEMPT_TABLES.has("organization_invite_index")).toBe(true);
      const cols = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'organization_invite_index' ORDER BY column_name");
      expect(cols.rows.map((r) => r.column_name)).toEqual(["code_hash", "created_at", "id", "organization_id"]);
    });

    it("mm_app can read and insert but never update, delete or truncate it", async () => {
      await asApp(null, async (q) => {
        expect((await q("SELECT id FROM organization_invite_index")).rows.length).toBe(2); // by design: not tenant-scoped
      });
      for (const stmt of [
        "DELETE FROM organization_invite_index",
        "TRUNCATE organization_invite_index",
        "UPDATE organization_invite_index SET code_hash = 'x'",
        "UPDATE organization_invite_index SET organization_id = gen_random_uuid()",
        "UPDATE organization_invite_index SET id = gen_random_uuid()",
      ]) {
        await asApp(a.organizationId, async (q) => {
          await expect(q(stmt), stmt).rejects.toThrow(/permission denied/i);
        });
      }
    });

    it("a lookup row for another organization's invite (or one that does not exist) cannot be forged from inside a tenant transaction", async () => {
      const attempts: Array<[string, unknown[]]> = [
        [`INSERT INTO organization_invite_index (id, organization_id, code_hash) VALUES (gen_random_uuid(), $1, 'forged1')`, [b.organizationId]],
        [`INSERT INTO organization_invite_index (id, organization_id, code_hash) VALUES ($2, $1, 'forged2')`, [b.organizationId, inviteA.id]],
        [`INSERT INTO organization_invite_index (id, organization_id, code_hash) VALUES ($2, $1, 'forged3')`, [a.organizationId, inviteB.id]],
      ];
      for (const [text, values] of attempts) {
        await asApp(a.organizationId, async (q) => {
          await expect(q(text, values)).rejects.toThrow(/foreign key|violates/i);
        });
      }
      // And a second hash for A's own existing invite cannot be added by a different organization's scope either.
      await asApp(b.organizationId, async (q) => {
        await expect(q(`INSERT INTO organization_invite_index (id, organization_id, code_hash) VALUES ($2, $1, 'forged4')`, [a.organizationId, inviteA.id])).rejects.toThrow(/foreign key|violates/i);
      });
    });

    it("exposes nothing beyond what opens the tenant transaction: resolving a hash yields only ids, and a wrong hash yields nothing", async () => {
      await asApp(null, async (q) => {
        const hit = await q("SELECT * FROM organization_invite_index WHERE code_hash = $1", [hashInviteCode(inviteB.code)]);
        expect(hit.rows).toHaveLength(1);
        expect(Object.keys(hit.rows[0]).sort()).toEqual(["code_hash", "created_at", "id", "organization_id"]);
        expect(hit.rows[0].organization_id).toBe(b.organizationId);
        expect((await q("SELECT * FROM organization_invite_index WHERE code_hash = $1", [hashInviteCode("mmj_" + "a".repeat(32))])).rows).toEqual([]);
      });
    });

    it("an unscoped caller who learns an invite id from the index still reads nothing about the invite (the invite row is RLS-protected)", async () => {
      await asApp(null, async (q) => {
        const id = (await q("SELECT id FROM organization_invite_index LIMIT 1")).rows[0].id;
        expect((await q("SELECT * FROM organization_invites WHERE id = $1", [id])).rows).toEqual([]);
      });
    });
  });

  it("deleting an organization (the thing archive deliberately is not) is impossible for the application role", async () => {
    // Documented for the runbook (docs/operations.md): only a DBA-level connection outside the app can remove an organization.
    await asApp(a.organizationId, async (q) => {
      await expect(q("DELETE FROM organizations WHERE id = $1", [a.organizationId])).rejects.toThrow(/permission denied/i);
    });
    await asApp(a.organizationId, async (q) => {
      await expect(q("TRUNCATE organizations CASCADE")).rejects.toThrow(/permission denied/i);
    });
  });
});
