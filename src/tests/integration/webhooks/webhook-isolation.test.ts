import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { enableWebhookEncryption, fakeResolver, fakeTransport, makeSubscription } from "../../helpers/webhooks";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { WebhookDispatchService } from "@/domain/webhooks/dispatch-service";
import { evaluateIsolation, loadTableSecurityRows } from "@/db/isolation-audit";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Tenant isolation and grants for the four new tables, verified as the REAL restricted `mm_app` role over a raw
 * connection (not through the ORM), plus the build-time isolation audit itself.
 */
const NEW_TABLES = ["domain_events", "webhook_subscriptions", "webhook_deliveries", "webhook_delivery_attempts"] as const;

describe("webhook tables: row-level security and grants as the real mm_app role", () => {
  let app: pg.Pool;
  let admin: pg.Pool;
  let a: { owner: Actor; orgId: string };
  let b: { owner: Actor; orgId: string };

  beforeAll(() => {
    enableWebhookEncryption();
    app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    admin = new pg.Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });
  });
  afterAll(async () => {
    await app.end();
    await admin.end();
    await closeTestPools();
  });

  beforeEach(async () => {
    enableWebhookEncryption();
    await resetDatabase();
    const orgA = await createTestOrg("iso-a");
    const orgB = await createTestOrg("iso-b");
    a = { owner: orgA.owner, orgId: orgA.organizationId };
    b = { owner: orgB.owner, orgId: orgB.organizationId };
    for (const [org, owner] of [[orgA, a.owner], [orgB, b.owner]] as const) {
      const sales = await createSalesFixtures(owner, org.baseCurrency);
      await makeSubscription(owner, { url: `https://${org === orgA ? "a" : "b"}.example.com/x`, eventTypes: ["invoice.created"] });
      await InvoiceService.create(owner, {
        customerContactId: sales.customerContactId,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        currency: "AUD",
        arAccountId: sales.arAccountId,
        lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: sales.revenueAccountId }],
      });
      await WebhookDispatchService.dispatch(org.organizationId, { limit: 10 }, { resolver: fakeResolver(), transport: fakeTransport() });
    }
  });

  /** Runs `fn` on a connection scoped to `orgId` exactly like withTenant, then rolls back. */
  async function asApp<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      if (orgId) await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  /** Runs one statement inside a savepoint so several refusals can be checked in one transaction. Returns the error text ('' on success). */
  const savepointError = async (c: pg.PoolClient, text: string, params: unknown[] = []) => {
    await c.query("SAVEPOINT probe");
    try {
      await c.query(text, params);
      await c.query("RELEASE SAVEPOINT probe");
      return "";
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT probe");
      return (e as Error).message;
    }
  };
  const errorOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("the build-time isolation audit passes and counts all four tables as FORCEd, policy-protected tenant tables", async () => {
    const rows = await loadTableSecurityRows(admin);
    expect(evaluateIsolation(rows).problems).toEqual([]);
    for (const table of NEW_TABLES) {
      const row = rows.find((r) => r.table_name === table)!;
      expect(row, table).toMatchObject({ tenant_scoped: true, rls_enabled: true, rls_forced: true, app_can_select: true });
      expect(Number(row.policies), table).toBeGreaterThanOrEqual(1);
      for (const expr of row.policy_exprs) expect(expr).toContain("app.current_org_id");
    }
  });

  it.each(NEW_TABLES)("%s: each organization sees only its own rows; with no organization set, mm_app sees none", async (table) => {
    const total = Number((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    expect(total).toBeGreaterThanOrEqual(2);
    const seenA = await asApp(a.orgId, async (c) => (await c.query(`SELECT organization_id FROM ${table}`)).rows);
    const seenB = await asApp(b.orgId, async (c) => (await c.query(`SELECT organization_id FROM ${table}`)).rows);
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenB.length).toBeGreaterThan(0);
    expect(seenA.every((r) => r.organization_id === a.orgId)).toBe(true);
    expect(seenB.every((r) => r.organization_id === b.orgId)).toBe(true);
    expect(seenA.length + seenB.length).toBe(total);
    expect(await asApp(null, async (c) => (await c.query(`SELECT 1 FROM ${table}`)).rows.length)).toBe(0);
  });

  it("an organization cannot write a row for another organization (WITH CHECK), in any of the four tables", async () => {
    const eventA = (await admin.query(`SELECT id FROM domain_events WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const subA = (await admin.query(`SELECT id FROM webhook_subscriptions WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const deliveryA = (await admin.query(`SELECT id FROM webhook_deliveries WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const userA = a.owner.userId;
    const attempts: Array<[string, string, unknown[]]> = [
      ["domain_events", `INSERT INTO domain_events (organization_id, type, aggregate_type, aggregate_id, payload) VALUES ($1, 'x', 'x', gen_random_uuid(), '{}')`, [b.orgId]],
      [
        "webhook_subscriptions",
        `INSERT INTO webhook_subscriptions (organization_id, url, event_types, created_by_user_id, secret_ciphertext, secret_key_version) VALUES ($1, 'https://x.example.com', ARRAY['invoice.created'], $2, 'c', 1)`,
        [b.orgId, userA],
      ],
      ["webhook_deliveries", `INSERT INTO webhook_deliveries (organization_id, event_id, subscription_id) VALUES ($1, $2, $3)`, [b.orgId, eventA, subA]],
      [
        "webhook_delivery_attempts",
        `INSERT INTO webhook_delivery_attempts (organization_id, delivery_id, attempt_number, trigger, started_at, duration_ms) VALUES ($1, $2, 99, 'AUTO', now(), 1)`,
        [b.orgId, deliveryA],
      ],
    ];
    for (const [table, sqlText, params] of attempts) {
      const message = await asApp(a.orgId, (c) => errorOf(() => c.query(sqlText, params)));
      expect(message, table).toMatch(/row-level security/);
    }
    // ...and a same-organization insert works (so the refusals above are about the organization, not the statement).
    const ok = await asApp(a.orgId, (c) => errorOf(() => c.query(attempts[3]![1], [a.orgId, deliveryA])));
    expect(ok).toBe("");
  });

  it("the attempt log is APPEND-ONLY for the application role: INSERT and SELECT only; UPDATE, DELETE and TRUNCATE are denied", async () => {
    const privileges = (await admin.query(
      `SELECT has_table_privilege('mm_app', 'webhook_delivery_attempts', 'INSERT') AS i, has_table_privilege('mm_app', 'webhook_delivery_attempts', 'SELECT') AS s,
              has_table_privilege('mm_app', 'webhook_delivery_attempts', 'UPDATE') AS u, has_table_privilege('mm_app', 'webhook_delivery_attempts', 'DELETE') AS d,
              has_table_privilege('mm_app', 'webhook_delivery_attempts', 'TRUNCATE') AS t`,
    )).rows[0];
    expect(privileges).toEqual({ i: true, s: true, u: false, d: false, t: false });

    const before = (await admin.query(`SELECT id, status_code, response_excerpt FROM webhook_delivery_attempts WHERE organization_id = $1 ORDER BY id`, [a.orgId])).rows;
    expect(before.length).toBeGreaterThan(0);
    const messages = await asApp(a.orgId, async (c) => [
      await savepointError(c, `UPDATE webhook_delivery_attempts SET status_code = 418`),
      await savepointError(c, `UPDATE webhook_delivery_attempts SET response_excerpt = 'forged' WHERE organization_id = $1`, [a.orgId]),
      await savepointError(c, `DELETE FROM webhook_delivery_attempts`),
      await savepointError(c, `DELETE FROM webhook_delivery_attempts WHERE organization_id = $1`, [a.orgId]),
      await savepointError(c, `TRUNCATE webhook_delivery_attempts`),
    ]);
    for (const m of messages) expect(m).toMatch(/permission denied for table webhook_delivery_attempts/);
    const after = (await admin.query(`SELECT id, status_code, response_excerpt FROM webhook_delivery_attempts WHERE organization_id = $1 ORDER BY id`, [a.orgId])).rows;
    expect(after).toEqual(before);
  });

  it("an outbox event is immutable except for dispatched_at: type, aggregate and payload cannot be rewritten by the application role", async () => {
    const messages = await asApp(a.orgId, async (c) => [
      await savepointError(c, `UPDATE domain_events SET payload = '{"forged":true}'`),
      await savepointError(c, `UPDATE domain_events SET type = 'invoice.paid'`),
      await savepointError(c, `UPDATE domain_events SET aggregate_id = gen_random_uuid()`),
      await savepointError(c, `UPDATE domain_events SET occurred_at = now()`),
    ]);
    for (const m of messages) expect(m).toMatch(/permission denied for table domain_events/);
    const allowed = await asApp(a.orgId, (c) => errorOf(() => c.query(`UPDATE domain_events SET dispatched_at = now()`)));
    expect(allowed).toBe("");
  });

  it("retention DELETE of an event is scoped to the caller's organization and cascades to its deliveries and attempts (owner-run FK action)", async () => {
    const deleted = await asApp(a.orgId, async (c) => {
      const r = await c.query(`DELETE FROM domain_events`);
      const leftover = (await c.query(`SELECT (SELECT count(*) FROM webhook_deliveries)::int AS d, (SELECT count(*) FROM webhook_delivery_attempts)::int AS a`)).rows[0];
      return { count: r.rowCount, leftover };
    });
    expect(deleted.count).toBeGreaterThan(0);
    expect(deleted.leftover).toEqual({ d: 0, a: 0 });
    // ...and it never touched the other organization (the transaction above was rolled back; check B directly anyway).
    const bRows = await asApp(b.orgId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM domain_events`)).rows[0].n);
    expect(bRows).toBeGreaterThan(0);
  });

  it("deliveries are unique per (event, subscription): a second insert for the same pair is rejected", async () => {
    const row = (await admin.query(`SELECT event_id, subscription_id FROM webhook_deliveries WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0];
    const message = await asApp(a.orgId, (c) => errorOf(() => c.query(`INSERT INTO webhook_deliveries (organization_id, event_id, subscription_id) VALUES ($1, $2, $3)`, [a.orgId, row.event_id, row.subscription_id])));
    expect(message).toMatch(/webhook_deliveries_event_sub_unique|duplicate key/);
  });
});
