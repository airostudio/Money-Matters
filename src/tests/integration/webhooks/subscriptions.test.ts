import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { disableWebhookEncryption, enableWebhookEncryption, fakeResolver, makeSubscription } from "../../helpers/webhooks";
import { auditLogs, webhookSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { ROLE_PERMISSIONS, roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { effectivePermissions, API_SCOPES } from "@/domain/api/scopes";
import {
  InvalidWebhookInputError,
  MAX_SUBSCRIPTIONS_PER_ORG,
  WebhookNotFoundError,
  WebhookSubscriptionService,
} from "@/domain/webhooks/subscription-service";
import { WebhookEncryptionUnavailableError, decryptSecret, requireKeyring } from "@/domain/webhooks/secret-crypto";

describe("webhook subscription management", () => {
  afterAll(closeTestPools);
  beforeAll(enableWebhookEncryption);

  let owner: Actor;
  let orgId: string;
  let other: { owner: Actor; orgId: string };

  beforeEach(async () => {
    enableWebhookEncryption();
    await resetDatabase();
    const a = await createTestOrg("wh-a");
    const b = await createTestOrg("wh-b");
    owner = a.owner;
    orgId = a.organizationId;
    other = { owner: b.owner, orgId: b.organizationId };
  });

  const rowOf = (id: string) =>
    withTenant(orgId, async (tx) => (await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)))[0]!);
  const auditText = async () =>
    JSON.stringify(await withTenant(orgId, (tx) => tx.select().from(auditLogs)));

  describe("creation and secret handling", () => {
    it("returns the secret exactly once; stores only AES-GCM ciphertext; never returns it from list; never audits it", async () => {
      const { subscription, secret } = await makeSubscription(owner, { description: "ERP" });
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

      const row = await rowOf(subscription.id);
      expect(row.secretCiphertext).not.toContain(secret);
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row.secretKeyVersion).toBe(1);
      // It decrypts back to the secret shown once - with the right key and context only.
      const keyring = requireKeyring();
      expect(decryptSecret(row.secretCiphertext, { organizationId: orgId, subscriptionId: subscription.id }, keyring)).toBe(secret);

      const listed = await WebhookSubscriptionService.list(owner);
      expect(listed).toHaveLength(1);
      const listedJson = JSON.stringify(listed);
      expect(listedJson).not.toContain(secret);
      expect(listedJson).not.toContain(row.secretCiphertext);
      expect(listedJson.toLowerCase()).not.toMatch(/ciphertext|secret/);

      const audit = await auditText();
      expect(audit).not.toContain(secret);
      expect(audit).not.toContain(row.secretCiphertext);
      expect(audit).toContain("webhook_subscription.created");
    });

    it("normalises and validates event types: closed list, de-duplicated, no wildcard", async () => {
      const { subscription } = await makeSubscription(owner, { eventTypes: ["invoice.paid", "invoice.created", "invoice.paid"] });
      expect(subscription.eventTypes).toEqual(["invoice.created", "invoice.paid"]); // catalogue order, no duplicates
      await expect(makeSubscription(owner, { eventTypes: ["*"] })).rejects.toThrow(/Wildcard/);
      await expect(makeSubscription(owner, { eventTypes: ["invoice.*"] })).rejects.toThrow(InvalidWebhookInputError);
      await expect(makeSubscription(owner, { eventTypes: ["payroll.completed"] })).rejects.toThrow(/not an event type/);
      await expect(makeSubscription(owner, { eventTypes: ["bank.transaction.created"] })).rejects.toThrow(InvalidWebhookInputError);
      await expect(makeSubscription(owner, { eventTypes: ["ping"] })).rejects.toThrow(InvalidWebhookInputError);
      await expect(makeSubscription(owner, { eventTypes: [] })).rejects.toThrow(/at least one/);
    });

    it("refuses unsafe URLs at creation (the SSRF guard is applied to subscription validation)", async () => {
      const bad = [
        "http://hooks.example.com/x",
        "https://user:pw@hooks.example.com/x",
        "https://hooks.example.com:8443/x",
        "https://127.0.0.1/x",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/x",
        "https://localhost/x",
        "not a url",
      ];
      for (const url of bad) await expect(makeSubscription(owner, { url }), url).rejects.toThrow(InvalidWebhookInputError);
      // A name that RESOLVES to an internal address is refused too (any answer, mixed with public ones).
      for (const answers of [["10.0.0.5"], ["93.184.216.34", "192.168.1.9"], ["::ffff:169.254.169.254"], ["fd00::1"]]) {
        await expect(makeSubscription(owner, { url: "https://evil.example.com/x" }, fakeResolver({ "evil.example.com": answers })), answers.join(",")).rejects.toThrow(/not allowed/);
      }
      expect(await WebhookSubscriptionService.list(owner)).toHaveLength(0);
    });

    it("caps subscriptions per organization, even under concurrent creation", async () => {
      for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_ORG; i += 1) await makeSubscription(owner, { url: `https://hooks.example.com/${i}` });
      await expect(makeSubscription(owner)).rejects.toThrow(/at most 10/);
      await resetDatabase();
      const fresh = await createTestOrg("wh-cap");
      const results = await Promise.allSettled(Array.from({ length: MAX_SUBSCRIPTIONS_PER_ORG + 4 }, (_, i) => makeSubscription(fresh.owner, { url: `https://hooks.example.com/c${i}` })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_SUBSCRIPTIONS_PER_ORG);
      expect(await WebhookSubscriptionService.list(fresh.owner)).toHaveLength(MAX_SUBSCRIPTIONS_PER_ORG);
    });

    it("fails closed without the encryption key: nothing can be created or rotated, and the error says why", async () => {
      const { subscription } = await makeSubscription(owner);
      disableWebhookEncryption();
      await expect(makeSubscription(owner)).rejects.toThrow(WebhookEncryptionUnavailableError);
      await expect(makeSubscription(owner)).rejects.toThrow(/WEBHOOK_SECRET_ENCRYPTION_KEY is not set/);
      await expect(WebhookSubscriptionService.rotateSecret(owner, subscription.id)).rejects.toThrow(WebhookEncryptionUnavailableError);
      // Reading and managing non-secret state still works: the rest of the product is unaffected.
      expect(await WebhookSubscriptionService.list(owner)).toHaveLength(1);
      await WebhookSubscriptionService.setStatus(owner, subscription.id, "PAUSED");
    });
  });

  describe("permissions: OWNER and ADMINISTRATOR humans only", () => {
    it("webhook:manage is held by OWNER and ADMINISTRATOR only, and by no API scope", () => {
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        expect(roleHasPermission(role, "webhook:manage"), role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
      }
      for (const role of Object.keys(ROLE_PERMISSIONS) as MembershipRole[]) {
        expect(effectivePermissions([...API_SCOPES], role).has("webhook:manage"), role).toBe(false);
      }
    });

    it("every other role is refused every operation", async () => {
      const { subscription } = await makeSubscription(owner);
      const roles = (Object.keys(ROLE_PERMISSIONS) as MembershipRole[]).filter((r) => r !== "OWNER" && r !== "ADMINISTRATOR");
      for (const role of roles) {
        const actor = actorWithRole(owner, role);
        await expect(makeSubscription(actor), role).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.list(actor), role).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.update(actor, subscription.id, { description: "x" }), role).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.setStatus(actor, subscription.id, "PAUSED"), role).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.rotateSecret(actor, subscription.id), role).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.remove(actor, subscription.id), role).rejects.toThrow(PermissionDeniedError);
      }
      // A real second member as ADMINISTRATOR can; as ACCOUNTANT cannot.
      const admin = await addTestMember(owner, "ADMINISTRATOR");
      expect(await WebhookSubscriptionService.list(admin)).toHaveLength(1);
      const accountant = await addTestMember(owner, "ACCOUNTANT");
      await expect(WebhookSubscriptionService.list(accountant)).rejects.toThrow(PermissionDeniedError);
    });

    it("API-key, AI and SYSTEM actors are refused even with an OWNER role and every permission", async () => {
      const { subscription } = await makeSubscription(owner);
      for (const type of ["API", "AI", "SYSTEM"] as const) {
        const actor: Actor = { ...owner, type };
        await expect(makeSubscription(actor), type).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.list(actor), type).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.rotateSecret(actor, subscription.id), type).rejects.toThrow(PermissionDeniedError);
        await expect(WebhookSubscriptionService.remove(actor, subscription.id), type).rejects.toThrow(PermissionDeniedError);
      }
      expect(await WebhookSubscriptionService.list(owner)).toHaveLength(1);
    });
  });

  describe("mutations are audited, and tenants are isolated", () => {
    it("update, pause, resume, rotate and delete each write an audit row without any secret material", async () => {
      const { subscription, secret } = await makeSubscription(owner);
      await WebhookSubscriptionService.update(owner, subscription.id, { description: "Renamed", eventTypes: ["invoice.paid"], url: "https://hooks.example.com/v2" }, { resolver: fakeResolver() });
      await WebhookSubscriptionService.setStatus(owner, subscription.id, "PAUSED");
      await WebhookSubscriptionService.setStatus(owner, subscription.id, "ACTIVE");
      const rotated = await WebhookSubscriptionService.rotateSecret(owner, subscription.id);
      await WebhookSubscriptionService.remove(owner, subscription.id);

      const actions = (await withTenant(orgId, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs))).map((r) => r.action);
      for (const expected of ["webhook_subscription.created", "webhook_subscription.updated", "webhook_subscription.paused", "webhook_subscription.resumed", "webhook_subscription.secret_rotated", "webhook_subscription.deleted"]) {
        expect(actions, expected).toContain(expected);
      }
      const audit = await auditText();
      expect(audit).not.toContain(secret);
      expect(audit).not.toContain(rotated.secret);
      expect(audit).not.toMatch(/whsec_/);
      expect(audit.toLowerCase()).not.toContain("ciphertext");
    });

    it("update re-validates the URL (an unsafe new URL is refused and the old one kept)", async () => {
      const { subscription } = await makeSubscription(owner);
      await expect(WebhookSubscriptionService.update(owner, subscription.id, { url: "https://10.0.0.1/x" }, { resolver: fakeResolver() })).rejects.toThrow(InvalidWebhookInputError);
      expect((await rowOf(subscription.id)).url).toBe("https://hooks.example.com/mm");
    });

    it("another organization's owner can neither see nor change this organization's subscriptions", async () => {
      const { subscription } = await makeSubscription(owner);
      expect(await WebhookSubscriptionService.list(other.owner)).toHaveLength(0);
      await expect(WebhookSubscriptionService.update(other.owner, subscription.id, { description: "hijack" })).rejects.toThrow(WebhookNotFoundError);
      await expect(WebhookSubscriptionService.setStatus(other.owner, subscription.id, "PAUSED")).rejects.toThrow(WebhookNotFoundError);
      await expect(WebhookSubscriptionService.rotateSecret(other.owner, subscription.id)).rejects.toThrow(WebhookNotFoundError);
      await expect(WebhookSubscriptionService.remove(other.owner, subscription.id)).rejects.toThrow(WebhookNotFoundError);
      expect((await rowOf(subscription.id)).description).toBeNull();
    });

    it("re-enabling a DISABLED subscription resets the failure counter and clears the reason", async () => {
      const { subscription } = await makeSubscription(owner);
      await withTenant(orgId, (tx) =>
        tx.update(webhookSubscriptions).set({ status: "DISABLED", statusReason: "Automatically disabled", consecutiveFailures: 20 }).where(eq(webhookSubscriptions.id, subscription.id)),
      );
      const summary = await WebhookSubscriptionService.setStatus(owner, subscription.id, "ACTIVE");
      expect(summary).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0, statusReason: null });
      const actions = (await withTenant(orgId, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs))).map((r) => r.action);
      expect(actions).toContain("webhook_subscription.re_enabled");
    });
  });
});
