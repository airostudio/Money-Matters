import { FAKE_SLACK_URL } from "../../helpers/slack";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { auditLogs, integrationConnections, integrationEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { closeTestPools, addTestMember, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { disableWebhookEncryption, enableWebhookEncryption, fakeResolver, fakeTransport, TEST_ENCRYPTION_KEY } from "../../helpers/webhooks";
import { jobsOf, makeRule, passDeps, ruleRow, runsOf } from "../../helpers/automation";
import { AutomationEngine } from "@/domain/automation/engine";
import { AutomationRuleService, InvalidRuleError } from "@/domain/automation/rule-service";
import { IntegrationEncryptionUnavailableError, IntegrationNotFoundError, IntegrationService, InvalidIntegrationInputError } from "@/domain/integrations/connection-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { decryptSecret, encryptSecret, loadKeyring } from "@/domain/security/secret-encryption";
import { SecretDecryptionError } from "@/domain/webhooks/secret-crypto";

const URL_A = FAKE_SLACK_URL;

describe("integrations: connection management and the SEND_TO_CHANNEL action", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let currency: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    enableWebhookEncryption();
    tracker.reset();
    const org = await createTestOrg("integrations");
    owner = org.owner;
    orgId = org.organizationId;
    currency = org.baseCurrency;
    sales = await createSalesFixtures(owner, currency);
  });

  const connect = (actor: Actor = owner, url = URL_A, extra: Record<string, unknown> = {}) =>
    IntegrationService.create(actor, { providerId: "slack_incoming_webhook", name: "Finance alerts", config: { webhookUrl: url, includeAmounts: false, ...extra } }, { resolver: fakeResolver() });
  const invoice = () =>
    InvoiceService.create(owner, {
      customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-31"), currency, arAccountId: sales.arAccountId,
      lines: [{ description: "Consulting", quantity: "10", unitPrice: "100.00", accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
    });
  const channelRule = (connectionId: string, extra: Record<string, unknown> = {}) => makeRule(owner, { name: "To Slack", action: { type: "SEND_TO_CHANNEL", connectionId }, ...extra });
  const everything = async () => {
    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      const tables = ["audit_logs", "integration_events", "integration_connections", "automation_runs", "automation_jobs", "automation_rules", "domain_events", "notifications"];
      const out: Record<string, unknown> = {};
      for (const t of tables) out[t] = (await admin.query(`SELECT * FROM ${t}`)).rows;
      return out;
    } finally {
      await admin.end();
    }
  };

  describe("connection management", () => {
    it("connects, encrypts the URL at rest bound to (purpose, organization, connection), and returns/shows/audits only a masked tail", async () => {
      const summary = await connect();
      expect(summary).toMatchObject({ providerId: "slack_incoming_webhook", status: "CONNECTED", canSend: true, name: "Finance alerts" });
      expect(summary.publicConfig).toEqual({ includeAmounts: false, channelLabel: null, maskedUrl: "hooks.slack.com/services/…UVWX" });
      expect(JSON.stringify(summary)).not.toMatch(/T0123ABCD|abcdEFGH/);

      const [row] = await withTenant(orgId, (tx) => tx.select().from(integrationConnections));
      expect(row!.secretCiphertext).toBeTruthy();
      expect(row!.secretCiphertext).not.toContain("hooks.slack.com");
      expect(Buffer.from(row!.secretCiphertext!, "base64").toString("latin1")).not.toContain("hooks.slack.com");
      const keyring = (loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }) as { ok: true; keyring: never }).keyring;
      const context = { organizationId: orgId, subscriptionId: row!.id, purpose: "integration" as const };
      expect(JSON.parse(decryptSecret(row!.secretCiphertext!, context, keyring))).toEqual({ webhookUrl: URL_A });
      // Bound to its purpose, organization and row: none of these re-presentations decrypt.
      expect(() => decryptSecret(row!.secretCiphertext!, { ...context, purpose: "webhook" }, keyring)).toThrow(SecretDecryptionError);
      expect(() => decryptSecret(row!.secretCiphertext!, { ...context, organizationId: "00000000-0000-4000-8000-000000000000" }, keyring)).toThrow(SecretDecryptionError);
      expect(() => decryptSecret(row!.secretCiphertext!, { ...context, subscriptionId: "00000000-0000-4000-8000-000000000000" }, keyring)).toThrow(SecretDecryptionError);

      // Nowhere in the database, the audit log or the integration log is the URL or its token.
      const dump = JSON.stringify(await everything());
      expect(dump).not.toContain(URL_A);
      expect(dump).not.toContain("T0123ABCD");
      expect(dump).not.toContain("abcdEFGHijklMNOPqrstUVWX");
      const audit = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "integration.connected");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: "HUMAN", actorUserId: owner.userId });
      expect(JSON.stringify(audit[0]!.after)).not.toMatch(/hooks\.slack\.com|ciphertext/i);
    });

    it("refuses non-allowlisted, lookalike, private and plain-http addresses at connect time, and names no secret in the message", async () => {
      for (const url of ["https://hooks.slack.com.evil.com/services/T1/B1/secrettoken123", "https://evil.example.com/services/T1/B1/secrettoken123", "http://hooks.slack.com/services/T1/B1/secrettoken123", "https://localhost/services/T1/B1/secrettoken123", "https://127.0.0.1/services/T1/B1/secrettoken123"]) {
        const error = await connect(owner, url).catch((e) => e);
        expect(error, url).toBeInstanceOf(InvalidIntegrationInputError);
        expect((error as Error).message).not.toContain("secrettoken123");
      }
      // An allowlisted name that resolves to a private address is refused after DNS vetting.
      const rebinding = await IntegrationService.create(owner, { providerId: "slack_incoming_webhook", name: "x", config: { webhookUrl: URL_A } }, { resolver: fakeResolver({ "hooks.slack.com": ["192.168.1.10"] }) }).catch((e) => e);
      expect(rebinding).toBeInstanceOf(InvalidIntegrationInputError);
      expect(await withTenant(orgId, (tx) => tx.select().from(integrationConnections))).toHaveLength(0);
    });

    it("coming-soon and unknown providers cannot be connected", async () => {
      for (const providerId of ["microsoft_teams", "stripe", "plaid", "nonexistent"]) {
        await expect(IntegrationService.create(owner, { providerId, name: "x", config: {} }, { resolver: fakeResolver() }), providerId).rejects.toBeInstanceOf(InvalidIntegrationInputError);
      }
    });

    it("OWNER/ADMINISTRATOR humans only: other roles and API / AI / automation / system actors are refused for every operation", async () => {
      const summary = await connect();
      const accountant = await addTestMember(owner, "ACCOUNTANT", "Accountant");
      const admin = await addTestMember(owner, "ADMINISTRATOR", "Admin");
      for (const actor of [accountant, { ...owner, type: "API" as const }, { ...owner, type: "AI" as const }, { ...owner, type: "AUTOMATION" as const }, { ...owner, type: "SYSTEM" as const }]) {
        await expect(IntegrationService.list(actor)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(connect(actor)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.test(actor, summary.id)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.disconnect(actor, summary.id)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.remove(actor, summary.id)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.updateSettings(actor, summary.id, { name: "x" })).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.reconnect(actor, summary.id, { webhookUrl: URL_A })).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(IntegrationService.recentEventsForAll(actor)).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      expect(await IntegrationService.list(admin)).toHaveLength(1); // an ADMINISTRATOR human may
      // The send-target list (id + name only) is readable by anyone who can see automations.
      expect(await IntegrationService.listSendTargets(accountant)).toEqual([{ id: summary.id, name: "Finance alerts", providerName: "Slack (incoming webhook)", status: "CONNECTED" }]);
    });

    it("fails closed without the encryption key: nothing can be connected, tested or reconnected - but disconnecting still works and the rest of the app is untouched", async () => {
      const summary = await connect();
      disableWebhookEncryption();
      await expect(connect()).rejects.toBeInstanceOf(IntegrationEncryptionUnavailableError);
      await expect(IntegrationService.test(owner, summary.id)).rejects.toBeInstanceOf(IntegrationEncryptionUnavailableError);
      await expect(IntegrationService.reconnect(owner, summary.id, { webhookUrl: URL_A })).rejects.toBeInstanceOf(IntegrationEncryptionUnavailableError);
      expect(await IntegrationService.list(owner)).toHaveLength(1); // listing never needs the key
      await IntegrationService.disconnect(owner, summary.id);
      const [row] = await withTenant(orgId, (tx) => tx.select().from(integrationConnections));
      expect(row).toMatchObject({ status: "DISCONNECTED", secretCiphertext: null, secretKeyVersion: null });
      await InvoiceService.create(owner, { customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-31"), currency, arAccountId: sales.arAccountId, lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: sales.revenueAccountId }] });
    });

    it("test sends the labelled test message and records OK / ERROR; disconnect erases the secret; remove needs a prior disconnect", async () => {
      const summary = await connect();
      const ok = fakeTransport();
      const result = await IntegrationService.test(owner, summary.id, { resolver: fakeResolver(), transport: ok });
      expect(result.ok).toBe(true);
      expect(JSON.parse(ok.calls[0]!.body).text).toContain("Money Matters test message");
      const bad = fakeTransport(() => ({ status: 404, bodyExcerpt: Buffer.from("no_service") }));
      const failed = await IntegrationService.test(owner, summary.id, { resolver: fakeResolver(), transport: bad });
      expect(failed.ok).toBe(false);
      let row = (await IntegrationService.list(owner))[0]!;
      expect(row).toMatchObject({ status: "ERROR" });
      expect(row.lastError).toMatch(/404/);
      await IntegrationService.test(owner, summary.id, { resolver: fakeResolver(), transport: ok });
      row = (await IntegrationService.list(owner))[0]!;
      expect(row).toMatchObject({ status: "CONNECTED", lastError: null, consecutiveFailures: 0 });

      await expect(IntegrationService.remove(owner, summary.id)).rejects.toBeInstanceOf(InvalidIntegrationInputError);
      await IntegrationService.disconnect(owner, summary.id);
      await expect(IntegrationService.test(owner, summary.id, { resolver: fakeResolver(), transport: ok })).rejects.toBeInstanceOf(InvalidIntegrationInputError);
      await IntegrationService.remove(owner, summary.id);
      expect(await IntegrationService.list(owner)).toHaveLength(0);
      const actions = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["integration.connected", "integration.tested", "integration.disconnected", "integration.removed"]));
    });

    it("isolation: another organization neither sees nor can touch this connection", async () => {
      const summary = await connect();
      const other = await createTestOrg("other-integrations");
      expect(await IntegrationService.list(other.owner)).toEqual([]);
      await expect(IntegrationService.test(other.owner, summary.id, { resolver: fakeResolver(), transport: fakeTransport() })).rejects.toBeInstanceOf(IntegrationNotFoundError);
      await expect(IntegrationService.disconnect(other.owner, summary.id)).rejects.toBeInstanceOf(IntegrationNotFoundError);
      await expect(IntegrationService.updateSettings(other.owner, summary.id, { name: "mine now" })).rejects.toBeInstanceOf(IntegrationNotFoundError);
      // ...and a rule in the other org cannot name it.
      await expect(AutomationRuleService.create(other.owner, { name: "x", trigger: "invoice.created", action: { type: "SEND_TO_CHANNEL", connectionId: summary.id } })).rejects.toBeInstanceOf(InvalidRuleError);
      expect(await IntegrationService.listSendTargets(other.owner)).toEqual([]);
    });
  });

  describe("SEND_TO_CHANNEL", () => {
    it("sends once through the allowed host with minimal content, with NO transaction or connection open while the request is in flight", async () => {
      const summary = await connect();
      const rule = await channelRule(summary.id);
      await invoice();
      let activeAtSend = -1;
      let calls = 0;
      const transport = fakeTransport(() => {
        activeAtSend = tracker.active;
        calls += 1;
        return { status: 200, bodyExcerpt: Buffer.from("ok") };
      });
      tracker.reset();
      const result = await AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ transport }));
      expect(result.succeeded).toBe(1);
      expect(calls).toBe(1);
      expect(activeAtSend).toBe(0); // THE connection-discipline proof: no withTenant transaction was open during the send
      expect(tracker.maxActive).toBe(1); // and never two at once
      const call = transport.calls[0]!;
      expect(call.url.hostname).toBe("hooks.slack.com");
      const text = JSON.parse(call.body).text as string;
      expect(text).toContain("*To Slack*");
      expect(text).toMatch(/Invoice INV-\d+ for Acme Pty Ltd was created\./);
      expect(text).toContain("<https://app.example.test/");
      expect(text).not.toMatch(/1100|Total/); // amounts are off by default
      expect((await runsOf(orgId, rule)).map((r) => r.outcome)).toEqual(["SUCCESS"]);
      // A re-run sends nothing more.
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ transport }));
      expect(calls).toBe(1);
      // The connection's send log has the entry; no secret anywhere.
      const events = await withTenant(orgId, (tx) => tx.select().from(integrationEvents));
      expect(events.filter((e) => e.kind === "SEND" && e.ok)).toHaveLength(1);
      expect(JSON.stringify(await everything())).not.toContain("abcdEFGHijklMNOPqrstUVWX");
    });

    it("includes amounts only when the connection's toggle is on", async () => {
      const summary = await connect(owner, URL_A, { includeAmounts: true });
      await channelRule(summary.id);
      await invoice();
      const transport = fakeTransport();
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ transport }));
      expect(JSON.parse(transport.calls[0]!.body).text).toContain("Total 1100.00 AUD");
      await IntegrationService.updateSettings(owner, summary.id, { settings: { includeAmounts: false } });
      await invoice();
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ transport }));
      expect(JSON.parse(transport.calls[1]!.body).text).not.toContain("1100.00");
    });

    it("rule creation targets only a CONNECTED sendable connection of this organization", async () => {
      const summary = await connect();
      await expect(AutomationRuleService.create(owner, { name: "x", trigger: "invoice.created", action: { type: "SEND_TO_CHANNEL", connectionId: "00000000-0000-4000-8000-000000000000" } })).rejects.toBeInstanceOf(InvalidRuleError);
      await IntegrationService.disconnect(owner, summary.id);
      await expect(AutomationRuleService.create(owner, { name: "x", trigger: "invoice.created", action: { type: "SEND_TO_CHANNEL", connectionId: summary.id } })).rejects.toThrow(/not connected/);
    });

    it("a destination that fails the allowlist/SSRF check at SEND time (a stored row is not trusted) never reaches the client", async () => {
      const summary = await connect();
      const rule = await channelRule(summary.id);
      // Replace the stored secret, behind the service's back, with a validly-encrypted but NON-allowlisted URL.
      const keyring = (loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }) as { ok: true; keyring: never }).keyring;
      const forged = encryptSecret(JSON.stringify({ webhookUrl: "https://evil.example.com/services/T1/B1/xyz" }), { organizationId: orgId, subscriptionId: summary.id, purpose: "integration" }, keyring);
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(`UPDATE integration_connections SET secret_ciphertext = $1 WHERE id = $2`, [forged.ciphertext, summary.id]);
      } finally {
        await admin.end();
      }
      await invoice();
      const transport = fakeTransport();
      const resolver = fakeResolver();
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, passDeps({ transport, resolver }));
      expect(transport.calls).toHaveLength(0);
      expect(resolver.calls).toHaveLength(0);
      const runs = await runsOf(orgId, rule);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "FAILED" });
      expect(runs[0]!.reason).toMatch(/not a Slack incoming-webhook address/);
      expect(runs[0]!.reason).not.toContain("evil.example.com/services/T1/B1/xyz");
    });

    it("a ciphertext moved to another connection row cannot be used (AAD binding)", async () => {
      const first = await connect();
      const second = await IntegrationService.create(owner, { providerId: "slack_incoming_webhook", name: "Second", config: { webhookUrl: "https://hooks.slack.com/services/T9/B9/zzzzzzzzzz" } }, { resolver: fakeResolver() });
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(`UPDATE integration_connections SET secret_ciphertext = (SELECT secret_ciphertext FROM integration_connections WHERE id = $1) WHERE id = $2`, [first.id, second.id]);
      } finally {
        await admin.end();
      }
      const transport = fakeTransport();
      const result = await IntegrationService.test(owner, second.id, { resolver: fakeResolver(), transport });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/could not be decrypted/);
      expect(transport.calls).toHaveLength(0);
    });

    it("failed sends are retried on later passes up to the cap, then FAIL; repeated failures set the connection to ERROR and, eventually, switch the rule off", async () => {
      const summary = await connect();
      const rule = await channelRule(summary.id);
      await invoice();
      const transport = fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.from("boom") }));
      const at = (iso: string) => passDeps({ transport, now: () => new Date(iso) });
      const base = Date.now();
      const t = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(0)));
      expect(transport.calls).toHaveLength(1);
      let job = (await jobsOf(orgId, rule))[0]!;
      expect(job).toMatchObject({ state: "RETRY", attempts: 1 });
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(0.5))); // not due yet
      expect(transport.calls).toHaveLength(1);
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(2)));
      expect(transport.calls).toHaveLength(2);
      job = (await jobsOf(orgId, rule))[0]!;
      expect(job).toMatchObject({ state: "RETRY", attempts: 2 });
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(10)));
      expect(transport.calls).toHaveLength(3);
      job = (await jobsOf(orgId, rule))[0]!;
      expect(job).toMatchObject({ state: "FAILED", attempts: 3 }); // capped: never again
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(60)));
      expect(transport.calls).toHaveLength(3);

      const runs = await runsOf(orgId, rule);
      expect(runs.map((r) => r.outcome)).toEqual(["FAILED", "FAILED", "FAILED"]);
      expect(runs.map((r) => r.attempt)).toEqual([1, 2, 3]);
      expect(runs[0]!.reason).toMatch(/Will retry/);
      expect(runs[2]!.reason).not.toMatch(/Will retry/);
      // Three consecutive failed sends flagged the connection.
      const conn = (await IntegrationService.list(owner))[0]!;
      expect(conn).toMatchObject({ status: "ERROR", consecutiveFailures: 3 });
      expect(conn.statusReason).toMatch(/Set to ERROR after 3 consecutive failed sends/);
      const actions = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).map((a) => a.action);
      expect(actions).toContain("integration.error_flagged");
      expect((await ruleRow(orgId, rule)).consecutiveFailures).toBe(3);

      // The channel is now ERROR, so further events fail fast ("not connected") until a person restores it; the 5th failure switches the rule off.
      await invoice();
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(61)));
      expect(transport.calls).toHaveLength(3);
      await invoice();
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, at(t(62)));
      const row = await ruleRow(orgId, rule);
      expect(row).toMatchObject({ enabled: false, disabledCode: "AUTO_FAILURES" });
      expect(row.disabledReason).toMatch(/Automatically switched off after 5 failed runs/);
      const auto = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "automation_rule.auto_disabled");
      expect(auto).toHaveLength(1);
      // Visible in the list too, and a person can switch it back on (a fresh approval that clears the counter).
      const view = (await AutomationRuleService.list(owner)).find((r) => r.id === rule)!;
      expect(view.enabled).toBe(false);
      expect(view.disabledReason).toMatch(/Automatically switched off/);
    });

    it("with the encryption key missing the send FAILS CLOSED (recorded, no request), while notification rules keep working", async () => {
      const summary = await connect();
      const sendRule = await channelRule(summary.id);
      const notifyRule = await makeRule(owner, { name: "Notify", action: { type: "NOTIFY_IN_APP", roles: ["OWNER"], userIds: [], severity: "INFO" } });
      await invoice();
      disableWebhookEncryption();
      const transport = fakeTransport();
      const noKey = passDeps({ transport, env: {} });
      await AutomationEngine.runPass(orgId, { source: "MANUAL" }, noKey);
      expect(transport.calls).toHaveLength(0);
      expect((await runsOf(orgId, sendRule))[0]).toMatchObject({ outcome: "FAILED" });
      expect((await runsOf(orgId, sendRule))[0]!.reason).toMatch(/Integrations are disabled/);
      expect((await runsOf(orgId, notifyRule)).map((r) => r.outcome)).toEqual(["SUCCESS"]);
    });
  });
});
