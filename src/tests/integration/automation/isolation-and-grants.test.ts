import { FAKE_SLACK_URL } from "../../helpers/slack";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { closeTestPools, addTestMember, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { enableWebhookEncryption, fakeResolver } from "../../helpers/webhooks";
import { makeRule, notificationsOf, passDeps } from "../../helpers/automation";
import { AutomationEngine } from "@/domain/automation/engine";
import { IntegrationService } from "@/domain/integrations/connection-service";
import { NotificationAccessError, NotificationService } from "@/domain/notifications/notification-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { evaluateIsolation, loadTableSecurityRows } from "@/db/isolation-audit";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Tenant isolation and grants for the Phase 10 Slice 3 tables, verified as the REAL restricted `mm_app` role over a raw
 * connection (not through the ORM), plus the build-time isolation audit itself, plus per-person notification privacy.
 */
const NEW_TABLES = ["automation_settings", "automation_rules", "automation_jobs", "automation_runs", "notifications", "integration_connections", "integration_events"] as const;
const URL_A = FAKE_SLACK_URL;

describe("automation, notification and integration tables: RLS and grants as the real mm_app role", () => {
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
    const orgA = await createTestOrg("auto-iso-a");
    const orgB = await createTestOrg("auto-iso-b");
    a = { owner: orgA.owner, orgId: orgA.organizationId };
    b = { owner: orgB.owner, orgId: orgB.organizationId };
    for (const [org, owner] of [[orgA, a.owner], [orgB, b.owner]] as const) {
      const sales = await createSalesFixtures(owner, org.baseCurrency);
      await IntegrationService.create(owner, { providerId: "slack_incoming_webhook", name: "chan", config: { webhookUrl: URL_A } }, { resolver: fakeResolver() });
      const { AutomationRuleService } = await import("@/domain/automation/rule-service");
      await AutomationRuleService.setAllPaused(owner, true);
      await AutomationRuleService.setAllPaused(owner, false);
      await new Promise((r) => setTimeout(r, 10));
      await makeRule(owner, { name: "n" });
      await InvoiceService.create(owner, { customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-31"), currency: "AUD", arAccountId: sales.arAccountId, lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: sales.revenueAccountId }] });
      await AutomationEngine.runPass(org.organizationId, { source: "MANUAL" }, passDeps());
    }
  });

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

  it("the build-time isolation audit passes and counts every new table as a FORCEd, policy-protected tenant table", async () => {
    const rows = await loadTableSecurityRows(admin);
    expect(evaluateIsolation(rows).problems).toEqual([]);
    for (const table of NEW_TABLES) {
      const row = rows.find((r) => r.table_name === table)!;
      expect(row, table).toMatchObject({ tenant_scoped: true, rls_enabled: true, rls_forced: true, app_can_select: true });
      expect(Number(row.policies), table).toBeGreaterThanOrEqual(1);
      for (const expr of row.policy_exprs) expect(expr).toContain("app.current_org_id");
    }
  });

  it.each(NEW_TABLES.filter((t) => t !== "notifications"))("%s: each organization sees only its own rows; with no organization set, mm_app sees none", async (table) => {
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

  it("notifications: organization isolation holds too (each org sees only its own; none without a scope)", async () => {
    await NotificationService.list(a.owner); // exercise the service once
    const admin2 = await admin.query(`SELECT organization_id FROM notifications`);
    expect(admin2.rows.length).toBeGreaterThanOrEqual(2);
    const seenA = await asApp(a.orgId, async (c) => (await c.query(`SELECT organization_id FROM notifications`)).rows);
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenA.every((r) => r.organization_id === a.orgId)).toBe(true);
    expect(await asApp(null, async (c) => (await c.query(`SELECT 1 FROM notifications`)).rows.length)).toBe(0);
  });

  it("an organization cannot write a row for another organization (WITH CHECK) in any new table", async () => {
    const userA = a.owner.userId;
    const ruleA = (await admin.query(`SELECT id FROM automation_rules WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const connA = (await admin.query(`SELECT id FROM integration_connections WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const attempts: Array<[string, string, unknown[]]> = [
      ["automation_settings", `INSERT INTO automation_settings (organization_id, all_paused) VALUES ($1, true)`, [b.orgId]],
      ["automation_rules", `INSERT INTO automation_rules (organization_id, name, trigger, action, created_by_user_id, authorised_by_user_id) VALUES ($1, 'x', 'invoice.created', '{}', $2, $2)`, [b.orgId, userA]],
      ["automation_jobs", `INSERT INTO automation_jobs (organization_id, rule_id, job_key, context) VALUES ($1, $2, 'k', '{}')`, [b.orgId, ruleA]],
      ["automation_runs", `INSERT INTO automation_runs (organization_id, rule_name, trigger, job_key, outcome, source, started_at, finished_at) VALUES ($1, 'x', 't', 'k', 'SUCCESS', 'MANUAL', now(), now())`, [b.orgId]],
      ["notifications", `INSERT INTO notifications (organization_id, recipient_user_id, title, source, group_key) VALUES ($1, $2, 't', 'automation', 'g')`, [b.orgId, userA]],
      ["integration_connections", `INSERT INTO integration_connections (organization_id, provider_id, name, created_by_user_id) VALUES ($1, 'slack_incoming_webhook', 'x', $2)`, [b.orgId, userA]],
      ["integration_events", `INSERT INTO integration_events (organization_id, connection_id, kind, ok) VALUES ($1, $2, 'TEST', true)`, [b.orgId, connA]],
    ];
    for (const [table, text, params] of attempts) {
      const message = await asApp(a.orgId, (c) => savepointError(c, text, params));
      expect(message, table).toMatch(/row-level security/);
    }
    // The same inserts succeed for the right organization, so the refusals above are about the organization.
    const ok = await asApp(a.orgId, async (c) => [
      await savepointError(c, attempts[3]![1], [a.orgId]),
      await savepointError(c, attempts[4]![1], [a.orgId, userA]),
      await savepointError(c, attempts[6]![1], [a.orgId, connA]),
    ]);
    expect(ok).toEqual(["", "", ""]);
  });

  it("the run log and the integration log are APPEND-ONLY for the application role: INSERT and SELECT only", async () => {
    for (const table of ["automation_runs", "integration_events"]) {
      const p = (await admin.query(
        `SELECT has_table_privilege('mm_app', $1, 'INSERT') AS i, has_table_privilege('mm_app', $1, 'SELECT') AS s, has_table_privilege('mm_app', $1, 'UPDATE') AS u,
                has_table_privilege('mm_app', $1, 'DELETE') AS d, has_table_privilege('mm_app', $1, 'TRUNCATE') AS t`,
        [table],
      )).rows[0];
      expect(p, table).toEqual({ i: true, s: true, u: false, d: false, t: false });
      const before = (await admin.query(`SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY id`, [a.orgId])).rows;
      expect(before.length, table).toBeGreaterThan(0);
      const messages = await asApp(a.orgId, async (c) => [
        await savepointError(c, `UPDATE ${table} SET created_at = now()`),
        await savepointError(c, `UPDATE ${table} SET created_at = now() WHERE organization_id = $1`, [a.orgId]),
        await savepointError(c, `DELETE FROM ${table}`),
        await savepointError(c, `DELETE FROM ${table} WHERE organization_id = $1`, [a.orgId]),
        await savepointError(c, `TRUNCATE ${table}`),
      ]);
      for (const m of messages) expect(m, table).toMatch(new RegExp(`permission denied for table ${table}`));
      expect((await admin.query(`SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY id`, [a.orgId])).rows).toEqual(before);
    }
  });

  it("an outbox event stays immutable except for the two processing flags: origin, type and payload cannot be rewritten", async () => {
    const messages = await asApp(a.orgId, async (c) => [
      await savepointError(c, `UPDATE domain_events SET origin = 'automation'`),
      await savepointError(c, `UPDATE domain_events SET payload = '{}'`),
      await savepointError(c, `UPDATE domain_events SET type = 'invoice.paid'`),
    ]);
    for (const m of messages) expect(m).toMatch(/permission denied for table domain_events/);
    const ok = await asApp(a.orgId, async (c) => [
      await savepointError(c, `UPDATE domain_events SET automation_processed_at = now()`),
      await savepointError(c, `UPDATE domain_events SET dispatched_at = now()`),
    ]);
    expect(ok).toEqual(["", ""]);
  });

  it("a notification's text, recipient and link cannot be rewritten: only the read / dismissed / fold columns move", async () => {
    const messages = await asApp(a.orgId, async (c) => [
      await savepointError(c, `UPDATE notifications SET title = 'forged'`),
      await savepointError(c, `UPDATE notifications SET body = 'forged'`),
      await savepointError(c, `UPDATE notifications SET recipient_user_id = gen_random_uuid()`),
      await savepointError(c, `UPDATE notifications SET link = '/x'`),
    ]);
    for (const m of messages) expect(m).toMatch(/permission denied for table notifications/);
    const ok = await asApp(a.orgId, async (c) => [await savepointError(c, `UPDATE notifications SET read_at = now(), dismissed_at = now(), occurrences = occurrences + 1, last_occurred_at = now()`)]);
    expect(ok).toEqual([""]);
  });

  it("jobs are unique per (rule, key): the dedupe guarantee is a database fact", async () => {
    const row = (await admin.query(`SELECT rule_id, job_key FROM automation_jobs WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0];
    const message = await asApp(a.orgId, (c) => savepointError(c, `INSERT INTO automation_jobs (organization_id, rule_id, job_key, context) VALUES ($1, $2, $3, '{}')`, [a.orgId, row.rule_id, row.job_key]));
    expect(message).toMatch(/automation_jobs_rule_key_unique|duplicate key/);
  });

  it("deleting a rule keeps its run history (rule_id is set to NULL by the owner-run FK action) and drops its jobs", async () => {
    const ruleId = (await admin.query(`SELECT id FROM automation_rules WHERE organization_id = $1 LIMIT 1`, [a.orgId])).rows[0].id as string;
    const runsBefore = Number((await admin.query(`SELECT count(*) FROM automation_runs WHERE rule_id = $1`, [ruleId])).rows[0].count);
    expect(runsBefore).toBeGreaterThan(0);
    await asApp(a.orgId, async (c) => {
      await c.query(`DELETE FROM automation_rules WHERE id = $1`, [ruleId]);
      const runs = (await c.query(`SELECT count(*)::int AS n FROM automation_runs WHERE rule_id IS NULL AND rule_name = 'n'`)).rows[0].n;
      const jobs = (await c.query(`SELECT count(*)::int AS n FROM automation_jobs WHERE rule_id = $1`, [ruleId])).rows[0].n;
      expect(runs).toBeGreaterThanOrEqual(runsBefore);
      expect(jobs).toBe(0);
    });
  });
});

describe("notifications are private to the person they belong to", () => {
  afterAll(closeTestPools);

  it("a colleague - even an OWNER or ADMINISTRATOR of the same organization - cannot read, mark, dismiss or purge someone else's notifications; other organizations see nothing", async () => {
    await resetDatabase();
    const org = await createTestOrg("notif-private");
    const sales = await createSalesFixtures(org.owner, org.baseCurrency);
    const accountant = await addTestMember(org.owner, "ACCOUNTANT", "Accountant");
    const admin = await addTestMember(org.owner, "ADMINISTRATOR", "Admin");
    await makeRule(org.owner, { action: { type: "NOTIFY_IN_APP", roles: ["ACCOUNTANT"], userIds: [], severity: "ACTION" } });
    await InvoiceService.create(org.owner, { customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-31"), currency: "AUD", arAccountId: sales.arAccountId, lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: sales.revenueAccountId }] });
    await AutomationEngine.runPass(org.organizationId, { source: "MANUAL" }, passDeps());

    const mine = await NotificationService.list(accountant);
    expect(mine).toHaveLength(1);
    expect(await NotificationService.unreadCount(accountant)).toBe(1);
    for (const other of [org.owner, admin]) {
      expect(await NotificationService.list(other)).toEqual([]);
      expect(await NotificationService.unreadCount(other)).toBe(0);
      expect(await NotificationService.markRead(other, mine[0]!.id)).toBe(false);
      expect(await NotificationService.dismiss(other, mine[0]!.id)).toBe(false);
      expect(await NotificationService.markAllRead(other)).toBe(0);
      expect(await NotificationService.purge(other, { olderThanDays: 1 }, new Date(Date.now() + 40 * 86_400_000))).toBe(0);
    }
    expect((await notificationsOf(org.organizationId, accountant.userId))[0]!.readAt).toBeNull();
    const elsewhere = await createTestOrg("notif-elsewhere");
    expect(await NotificationService.list({ ...elsewhere.owner })).toEqual([]);
    // Non-human actors can never use the inbox.
    for (const type of ["API", "AI", "AUTOMATION", "SYSTEM"] as const) await expect(NotificationService.list({ ...accountant, type })).rejects.toBeInstanceOf(NotificationAccessError);

    // The owner of the notification can read, dismiss, and purge on demand.
    expect(await NotificationService.markRead(accountant, mine[0]!.id)).toBe(true);
    expect(await NotificationService.unreadCount(accountant)).toBe(0);
    expect(await NotificationService.dismiss(accountant, mine[0]!.id)).toBe(true);
    expect(await NotificationService.list(accountant)).toEqual([]);
    expect(await NotificationService.purge(accountant)).toBe(1); // dismissed ones go
    expect(await notificationsOf(org.organizationId, accountant.userId)).toHaveLength(0);
  });

  it("identical unread items fold into one with a count instead of piling up; read ones start a new row", async () => {
    await resetDatabase();
    const org = await createTestOrg("notif-fold");
    const sales = await createSalesFixtures(org.owner, org.baseCurrency);
    await makeRule(org.owner, { name: "Same", conditions: [{ field: "currency", operator: "eq", value: "AUD" }] });
    // Two DIFFERENT invoices have different numbers, hence different bodies: they are not "identical". Fold needs the same text.
    const { withTenant } = await import("@/db/tenant");
    const owner = org.owner;
    const note = { title: "Same", body: "Identical text", link: null, severity: "INFO" as const, source: "automation" as const, sourceRefId: null };
    await withTenant(org.organizationId, (tx) => NotificationService.createIn(tx, org.organizationId, [owner.userId], note));
    await withTenant(org.organizationId, (tx) => NotificationService.createIn(tx, org.organizationId, [owner.userId], note));
    await withTenant(org.organizationId, (tx) => NotificationService.createIn(tx, org.organizationId, [owner.userId], note));
    let rows = await NotificationService.list(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(3);
    await NotificationService.markRead(owner, rows[0]!.id);
    await withTenant(org.organizationId, (tx) => NotificationService.createIn(tx, org.organizationId, [owner.userId], note));
    rows = await NotificationService.list(owner);
    expect(rows).toHaveLength(2);
    void sales;
  });
});
