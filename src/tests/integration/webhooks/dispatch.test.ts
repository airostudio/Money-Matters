import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, makeKey, post, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { TEST_ENCRYPTION_KEY, enableWebhookEncryption, eventsOf, fakeResolver, fakeTransport, makeSubscription, PUBLIC_IP } from "../../helpers/webhooks";
import { auditLogs, domainEvents, webhookDeliveries, webhookDeliveryAttempts, webhookSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { WebhookSubscriptionService, WebhookNotFoundError } from "@/domain/webhooks/subscription-service";
import { WebhookDispatchService, ReplayRefusedError, type DispatchDeps } from "@/domain/webhooks/dispatch-service";
import { pendingSummary, listRecentDeliveries, getDeliveryWithAttempts } from "@/domain/webhooks/delivery-queries";
import { RETRY_DELAYS_SECONDS } from "@/domain/webhooks/backoff";
import { verifySignature } from "@/domain/webhooks/signing";
import { TransportError } from "@/domain/webhooks/outbound";
import { configurePostResponseDispatch, scheduleDispatchAfterResponse } from "@/domain/webhooks/post-response";

describe("webhook dispatch: fan-out, delivery, retries, replay, breaker, ping", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let clock: Date;
  let sub: Awaited<ReturnType<typeof makeSubscription>>;

  const deps = (over: Partial<DispatchDeps> & { transport?: ReturnType<typeof fakeTransport> } = {}): DispatchDeps => ({
    resolver: fakeResolver(),
    transport: fakeTransport(),
    now: () => clock,
    random: () => 0.5,
    ...over,
  });

  const invoiceInput = () => ({
    customerContactId: sales.customerContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    arAccountId: sales.arAccountId,
    lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountId: sales.revenueAccountId }],
  });
  const newInvoice = () => InvoiceService.create(owner, invoiceInput());

  const deliveries = () =>
    withTenant(orgId, (tx) => tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.organizationId, orgId)).orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id)));
  const attempts = () =>
    withTenant(orgId, (tx) => tx.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.organizationId, orgId)).orderBy(asc(webhookDeliveryAttempts.createdAt), asc(webhookDeliveryAttempts.attemptNumber)));
  const subRow = () => withTenant(orgId, async (tx) => (await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.subscription.id)))[0]!);
  const dispatch = (d: DispatchDeps, limit = 10) => WebhookDispatchService.dispatch(orgId, { limit }, d);

  beforeEach(async () => {
    enableWebhookEncryption();
    configurePostResponseDispatch(null);
    await resetDatabase();
    resetApiThrottle();
    const org = await createTestOrg("wh-dispatch");
    owner = org.owner;
    orgId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    clock = new Date("2026-06-01T10:00:00.000Z");
    sub = await makeSubscription(owner, { eventTypes: ["invoice.created", "customer.created"] });
    // The fixture customer already emitted customer.created before the subscription existed; start from a clean outbox.
    await withTenant(orgId, (tx) => tx.update(domainEvents).set({ dispatchedAt: new Date() }).where(eq(domainEvents.organizationId, orgId)));
  });

  afterEach(() => {
    configurePostResponseDispatch(null);
    enableWebhookEncryption();
  });

  describe("fan-out and the happy path", () => {
    it("creates deliveries only for matching ACTIVE subscriptions, and marks the event dispatched", async () => {
      const paused = await makeSubscription(owner, { url: "https://paused.example.com/x", eventTypes: ["invoice.created"] });
      await WebhookSubscriptionService.setStatus(owner, paused.subscription.id, "PAUSED");
      await makeSubscription(owner, { url: "https://other-type.example.com/x", eventTypes: ["bill.created"] });

      await newInvoice();
      const d = deps();
      const result = await dispatch(d);
      expect(result).toMatchObject({ eventsFannedOut: 1, deliveriesCreated: 1, claimed: 1, delivered: 1, failed: 0 });

      const rows = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subscriptionId: sub.subscription.id, status: "DELIVERED", attemptCount: 1, autoAttempts: 1, nextAttemptAt: null, leaseUntil: null, lastStatusCode: 200 });
      expect((await eventsOf(orgId, "invoice.created"))[0]!.dispatchedAt).not.toBeNull();
      expect((d.transport as ReturnType<typeof fakeTransport>).calls).toHaveLength(1);
    });

    it("sends the stored envelope, correctly signed, with every identifying header and no more", async () => {
      await newInvoice();
      const transport = fakeTransport();
      await dispatch(deps({ transport }));
      const [request] = transport.calls;
      const event = (await eventsOf(orgId, "invoice.created"))[0]!;
      const [delivery] = await deliveries();

      expect(request!.url.toString()).toBe("https://hooks.example.com/mm");
      expect(JSON.parse(request!.body)).toEqual(event.payload);
      expect(request!.headers).toMatchObject({
        "Content-Type": "application/json",
        "User-Agent": "MoneyMatters-Webhooks/1",
        "Mm-Event-Id": event.id,
        "Mm-Event-Type": "invoice.created",
        "Mm-Delivery-Id": delivery!.id,
        "Mm-Subscription-Id": sub.subscription.id,
        "Mm-Delivery-Attempt": "1",
      });
      const signature = request!.headers["Mm-Signature"]!;
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      // The consumer, holding only the one-time secret, verifies it with the documented algorithm.
      expect(verifySignature(signature, request!.body, [sub.secret], Math.floor(clock.getTime() / 1000))).toEqual({ valid: true });
      expect(verifySignature(signature, request!.body, ["whsec_wrong"], Math.floor(clock.getTime() / 1000)).valid).toBe(false);
      expect(Object.keys(request!.headers).sort()).toEqual(["Content-Type", "Mm-Delivery-Attempt", "Mm-Delivery-Id", "Mm-Event-Id", "Mm-Event-Type", "Mm-Signature", "Mm-Subscription-Id", "User-Agent"]);
    });

    it("records the attempt: number, trigger, duration, status, sanitised excerpt", async () => {
      await newInvoice();
      await dispatch(deps({ transport: fakeTransport(() => ({ status: 200, bodyExcerpt: Buffer.from("thanks\u0000!") })) }));
      const [attempt] = await attempts();
      expect(attempt).toMatchObject({ attemptNumber: 1, trigger: "AUTO", triggeredByUserId: null, statusCode: 200, errorClass: null, responseExcerpt: "thanks !" });
      expect(attempt!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("is idempotent: dispatching twice sends once and creates one delivery", async () => {
      await newInvoice();
      const transport = fakeTransport();
      await dispatch(deps({ transport }));
      const second = await dispatch(deps({ transport }));
      expect(second).toMatchObject({ eventsFannedOut: 0, deliveriesCreated: 0, claimed: 0 });
      expect(transport.calls).toHaveLength(1);
      expect(await deliveries()).toHaveLength(1);
      expect(await attempts()).toHaveLength(1);
    });

    it("only sends the subscribed types (customer.created is subscribed, bill.created is not)", async () => {
      await ContactService.create(owner, { kind: "CUSTOMER", displayName: "New", currency: "AUD" });
      await ContactService.create(owner, { kind: "SUPPLIER", displayName: "Supp", currency: "AUD" });
      const transport = fakeTransport();
      await dispatch(deps({ transport }));
      expect(transport.calls.map((c) => c.headers["Mm-Event-Type"])).toEqual(["customer.created"]);
    });

    it("a subscription created AFTER an event does not receive it", async () => {
      const early = await newInvoice();
      void early;
      await withTenant(orgId, (tx) => tx.update(webhookSubscriptions).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(webhookSubscriptions.id, sub.subscription.id)));
      const transport = fakeTransport();
      const result = await dispatch(deps({ transport }));
      expect(result.deliveriesCreated).toBe(0);
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe("retries, backoff and dead letters", () => {
    it("a 500 schedules the next attempt per the backoff table; nothing is sent before it is due; then it is retried", async () => {
      await newInvoice();
      const transport = fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.from("boom") }));
      const r1 = await dispatch(deps({ transport }));
      expect(r1).toMatchObject({ claimed: 1, failed: 1, delivered: 0 });
      let [row] = await deliveries();
      expect(row).toMatchObject({ status: "PENDING", attemptCount: 1, autoAttempts: 1, lastStatusCode: 500, leaseUntil: null });
      expect(row!.nextAttemptAt!.getTime()).toBe(clock.getTime() + RETRY_DELAYS_SECONDS[0]! * 1000);
      expect(row!.lastError).toBe("HTTP 500");

      // Not due yet: a second dispatch (even "retry now") sends nothing.
      clock = new Date(clock.getTime() + 30_000);
      expect((await dispatch(deps({ transport }))).claimed).toBe(0);
      expect(transport.calls).toHaveLength(1);

      // Due: retried; attempt number 2; the backoff steps to the 5 minute slot.
      clock = new Date(clock.getTime() + 31_000);
      await dispatch(deps({ transport }));
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1]!.headers["Mm-Delivery-Attempt"]).toBe("2");
      [row] = await deliveries();
      expect(row).toMatchObject({ attemptCount: 2, autoAttempts: 2 });
      expect(row!.nextAttemptAt!.getTime()).toBe(clock.getTime() + RETRY_DELAYS_SECONDS[1]! * 1000);
    });

    it("a timeout and a connection error are retried exactly like an HTTP failure", async () => {
      await newInvoice();
      const transport = fakeTransport((_r, n) => {
        throw n === 1 ? new TransportError("timeout", "No complete response within 10s") : Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      });
      await dispatch(deps({ transport }));
      let [row] = await deliveries();
      expect(row).toMatchObject({ status: "PENDING", lastStatusCode: null });
      expect(row!.lastError).toMatch(/No complete response/);
      clock = new Date(clock.getTime() + 2 * 60_000);
      await dispatch(deps({ transport }));
      [row] = await deliveries();
      expect(row).toMatchObject({ attemptCount: 2 });
      expect((await attempts()).map((a) => a.errorClass)).toEqual(["timeout", "connect"]);
    });

    it("dead-letters after the 8th failed automatic attempt (FAILED, no next attempt), with the full attempt log, and never sends again on its own", async () => {
      await newInvoice();
      const transport = fakeTransport(() => ({ status: 503, bodyExcerpt: Buffer.from("down") }));
      for (let n = 1; n <= 8; n += 1) {
        const result = await dispatch(deps({ transport }));
        expect(result.claimed, `attempt ${n}`).toBe(1);
        const [row] = await deliveries();
        if (n < 8) {
          expect(row!.status).toBe("PENDING");
          expect(row!.nextAttemptAt!.getTime()).toBe(clock.getTime() + RETRY_DELAYS_SECONDS[n - 1]! * 1000);
          clock = new Date(row!.nextAttemptAt!.getTime() + 1000);
        } else {
          expect(result.deadLettered).toBe(1);
          expect(row).toMatchObject({ status: "FAILED", nextAttemptAt: null, attemptCount: 8, autoAttempts: 8 });
        }
      }
      clock = new Date(clock.getTime() + 30 * 86_400_000);
      expect((await dispatch(deps({ transport }))).claimed).toBe(0);
      expect(transport.calls).toHaveLength(8);
      expect((await attempts()).map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect((await subRow()).status).toBe("ACTIVE"); // 8 failures is well under the breaker threshold
    });

    it("a redirect (even to the metadata address) is a failure, recorded as such, and is not followed", async () => {
      await newInvoice();
      const transport = fakeTransport(() => ({ status: 302, bodyExcerpt: Buffer.from("Location: http://169.254.169.254/latest/meta-data/") }));
      await dispatch(deps({ transport }));
      expect(transport.calls).toHaveLength(1);
      const [row] = await deliveries();
      expect(row).toMatchObject({ status: "PENDING", lastStatusCode: 302 });
      expect((await attempts())[0]).toMatchObject({ errorClass: "redirect", statusCode: 302 });
    });
  });

  describe("SSRF at delivery time", () => {
    it.each([
      ["a private address", ["10.1.2.3"]],
      ["loopback", ["127.0.0.1"]],
      ["the cloud metadata address", ["169.254.169.254"]],
      ["an IPv4-mapped IPv6 private address", ["::ffff:192.168.1.1"]],
      ["a mix of public and private answers", [PUBLIC_IP, "10.0.0.1"]],
    ])("a host that now resolves to %s is never contacted; the attempt is logged as blocked", async (_name, answers) => {
      await newInvoice();
      const transport = fakeTransport();
      await dispatch(deps({ transport, resolver: fakeResolver({ "hooks.example.com": answers }) }));
      expect(transport.calls).toHaveLength(0);
      expect((await attempts())[0]).toMatchObject({ errorClass: "ssrf_blocked", statusCode: null });
      const [row] = await deliveries();
      expect(row!.status).toBe("PENDING"); // retried later; the DNS may be fixed
    });

    it("DNS rebinding: valid at subscription time, hostile at delivery time -> blocked; the transport only ever gets a vetted address", async () => {
      await newInvoice();
      let lookups = 0;
      const rebinding = async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? PUBLIC_IP : "169.254.169.254", family: 4 as const }];
      };
      const transport = fakeTransport();
      await dispatch(deps({ transport, resolver: rebinding }));
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.address.address).toBe(PUBLIC_IP);
      expect(lookups).toBe(1);

      await newInvoice();
      const hostileNow = fakeTransport();
      await dispatch(deps({ transport: hostileNow, resolver: async () => [{ address: "169.254.169.254", family: 4 as const }] }));
      expect(hostileNow.calls).toHaveLength(0);
    });

    it("a stored URL that is unsafe (tampered row) is refused at delivery without a lookup or a request", async () => {
      await newInvoice();
      await withTenant(orgId, (tx) => tx.update(webhookSubscriptions).set({ url: "https://169.254.169.254/latest/meta-data" }).where(eq(webhookSubscriptions.id, sub.subscription.id)));
      const resolver = fakeResolver();
      const transport = fakeTransport();
      await dispatch(deps({ transport, resolver }));
      expect(transport.calls).toHaveLength(0);
      expect(resolver.calls).toHaveLength(0);
      expect((await attempts())[0]!.errorClass).toBe("ssrf_blocked");
    });
  });

  describe("concurrency and connection discipline", () => {
    it("two dispatchers racing never double-send: every delivery is sent exactly once (repeated rounds, three dispatchers)", async () => {
      for (let round = 0; round < 4; round += 1) {
        for (let i = 0; i < 6; i += 1) await newInvoice();
        const sentBy = new Map<string, number>();
        const slow = fakeTransport(async (request) => {
          const id = request.headers["Mm-Delivery-Id"]!;
          sentBy.set(id, (sentBy.get(id) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 30));
          return { status: 200, bodyExcerpt: Buffer.from("ok") };
        });
        const results = await Promise.all([dispatch(deps({ transport: slow })), dispatch(deps({ transport: slow })), dispatch(deps({ transport: slow }))]);
        // Whatever the interleaving, each of the 6 new deliveries was sent once, in total.
        expect(sentBy.size, `round ${round}`).toBe(6);
        for (const [id, n] of sentBy) expect(n, `delivery ${id}`).toBe(1);
        expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(6);
        expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(6);
      }
      const rows = await deliveries();
      expect(rows.every((d) => d.status === "DELIVERED" && d.attemptCount === 1)).toBe(true);
      expect(await attempts()).toHaveLength(rows.length);
    });

    it("a crashed dispatcher's lease expires and the delivery becomes due again (at-least-once), but not before", async () => {
      await newInvoice();
      // Simulate: claimed (leased) but never completed.
      await dispatch(deps({ transport: fakeTransport() }), 1);
      const [done] = await deliveries();
      await withTenant(orgId, (tx) =>
        tx.update(webhookDeliveries).set({ status: "PENDING", leaseUntil: new Date(clock.getTime() + 120_000), nextAttemptAt: clock, deliveredAt: null }).where(eq(webhookDeliveries.id, done!.id)),
      );
      const transport = fakeTransport();
      expect((await dispatch(deps({ transport }))).claimed).toBe(0); // leased: invisible
      clock = new Date(clock.getTime() + 121_000);
      expect((await dispatch(deps({ transport }))).claimed).toBe(1); // lease expired
    });

    it("no transaction is open while the HTTP client runs, and no two scoped transactions ever overlap", async () => {
      for (let i = 0; i < 3; i += 1) await newInvoice();
      tracker.reset();
      const activeDuringSend: number[] = [];
      const transport = fakeTransport(() => {
        activeDuringSend.push(tracker.active);
        return { status: 200, bodyExcerpt: Buffer.from("ok") };
      });
      await dispatch(deps({ transport, onSend: () => activeDuringSend.push(tracker.active) }));
      expect(transport.calls).toHaveLength(3);
      expect(activeDuringSend).toHaveLength(6);
      expect(activeDuringSend.every((n) => n === 0)).toBe(true);
      expect(tracker.maxActive).toBe(1); // sequential: never two connections, never nested
    });

    it("query budget: phase A is a fixed handful of statements regardless of batch size; each delivery then costs a small fixed number", async () => {
      const statements: string[] = [];
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const first = args[0] as string | { text?: string };
        statements.push(typeof first === "string" ? first : (first?.text ?? ""));
        return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } as never);
      try {
        const measure = async (count: number) => {
          for (let i = 0; i < count; i += 1) await newInvoice();
          statements.length = 0;
          tracker.reset();
          await dispatch(deps({ transport: fakeTransport() }));
          return { total: statements.length, tenantCalls: tracker.tenantCalls.length, sql: [...statements] };
        };
        await measure(1); // warm-up: the lazy retention purge runs once per organization per hour and is not part of the steady-state cost
        const one = await measure(1);
        const five = await measure(5);
        // 1 phase-A transaction + one phase-B transaction per delivery.
        expect(one.tenantCalls).toBe(2);
        expect(five.tenantCalls).toBe(6);
        // Phase A: BEGIN, set_config, try-lock, [purge once], events, subscriptions, insert deliveries, update events, claim select, claim update, COMMIT.
        // Phase B (each): BEGIN, set_config, insert attempt, update delivery, update subscription, COMMIT.
        const phaseB = (five.total - one.total) / 4;
        expect(phaseB).toBe(6);
        expect(one.total).toBeLessThanOrEqual(2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 6 + 1); // fixed phase A (<= 13 incl. the lazy purge) + one delivery
        console.log(`[query budget] dispatch with 1 delivery: ${one.total} statements in 2 transactions; with 5 deliveries: ${five.total} statements in 6 transactions (phase B = ${phaseB} each)`);
        console.log(`[query budget] phase A statements: ${one.sql.slice(0, one.total - 6).map((s) => s.replace(/\s+/g, " ").slice(0, 48)).join(" | ")}`);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("circuit breaker", () => {
    it("auto-disables after 20 consecutive failures with a visible reason and a SYSTEM audit entry; re-enabling resets it", async () => {
      for (let i = 0; i < 20; i += 1) await newInvoice();
      const failing = fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.from("no") }));
      await dispatch(deps({ transport: failing }), 10);
      expect((await subRow())).toMatchObject({ status: "ACTIVE", consecutiveFailures: 10 });
      await dispatch(deps({ transport: failing }), 10);

      const disabled = await subRow();
      expect(disabled).toMatchObject({ status: "DISABLED", consecutiveFailures: 20 });
      expect(disabled.statusReason).toMatch(/Automatically disabled after 20 consecutive failed deliveries/);
      const audit = await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.action, "webhook_subscription.auto_disabled")));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: "SYSTEM", actorUserId: null, entityId: sub.subscription.id });
      expect(JSON.stringify(audit)).not.toContain(sub.secret);

      // Disabled: no new deliveries, nothing sent.
      await newInvoice();
      const ok = fakeTransport();
      const after = await dispatch(deps({ transport: ok }));
      expect(after).toMatchObject({ deliveriesCreated: 0, claimed: 0 });
      expect(ok.calls).toHaveLength(0);

      const summary = await WebhookSubscriptionService.setStatus(owner, sub.subscription.id, "ACTIVE");
      expect(summary).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0, statusReason: null });
    });

    it("a success resets the consecutive counter, so scattered failures never trip it", async () => {
      for (let i = 0; i < 12; i += 1) await newInvoice();
      let n = 0;
      const flaky = fakeTransport(() => ({ status: ++n % 3 === 0 ? 200 : 500, bodyExcerpt: Buffer.alloc(0) }));
      await dispatch(deps({ transport: flaky }), 10);
      await dispatch(deps({ transport: flaky }), 10);
      const row = await subRow();
      expect(row.status).toBe("ACTIVE");
      expect(row.consecutiveFailures).toBeLessThan(3);
    });
  });

  describe("replay", () => {
    const failOnce = async () => {
      await newInvoice();
      await dispatch(deps({ transport: fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.alloc(0) })) }));
      return (await deliveries())[0]!;
    };

    it("replays a delivery immediately as a fresh attempt, attributed to the person, audited, and delivers it", async () => {
      const failed = await failOnce();
      const transport = fakeTransport();
      const outcome = await WebhookDispatchService.replay(owner, failed.id, deps({ transport }));
      expect(outcome.success).toBe(true);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.headers["Mm-Delivery-Id"]).toBe(failed.id); // stable delivery id
      expect(transport.calls[0]!.headers["Mm-Delivery-Attempt"]).toBe("2");

      const [row] = await deliveries();
      expect(row).toMatchObject({ status: "DELIVERED", attemptCount: 2, autoAttempts: 1, nextAttemptAt: null, leaseUntil: null });
      const log = await attempts();
      expect(log[1]).toMatchObject({ trigger: "REPLAY", triggeredByUserId: owner.userId, attemptNumber: 2, statusCode: 200 });
      const audit = await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.action, "webhook_delivery.replayed")));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: owner.userId, actorType: "HUMAN", entityId: failed.id });
    });

    it("a replayed dead letter can be delivered; a failed replay never degrades the delivery or consumes the schedule", async () => {
      await newInvoice();
      const failing = fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.alloc(0) }));
      for (let n = 1; n <= 8; n += 1) {
        await dispatch(deps({ transport: failing }));
        const [r] = await deliveries();
        if (r!.nextAttemptAt) clock = new Date(r!.nextAttemptAt.getTime() + 1000);
      }
      expect((await deliveries())[0]!.status).toBe("FAILED");

      const stillFailing = await WebhookDispatchService.replay(owner, (await deliveries())[0]!.id, deps({ transport: failing }));
      expect(stillFailing.success).toBe(false);
      expect((await deliveries())[0]).toMatchObject({ status: "FAILED", autoAttempts: 8, attemptCount: 9 });
      expect((await subRow()).consecutiveFailures).toBe(8); // a manual replay failure does not feed the breaker

      await WebhookDispatchService.replay(owner, (await deliveries())[0]!.id, deps({ transport: fakeTransport() }));
      expect((await deliveries())[0]).toMatchObject({ status: "DELIVERED", attemptCount: 10 });
      expect((await subRow()).consecutiveFailures).toBe(0); // a real success resets it
    });

    it("an already-delivered event can be replayed (the consumer asked for it again)", async () => {
      await newInvoice();
      await dispatch(deps());
      const [row] = await deliveries();
      const transport = fakeTransport();
      expect((await WebhookDispatchService.replay(owner, row!.id, deps({ transport }))).success).toBe(true);
      expect(transport.calls).toHaveLength(1);
    });

    it("is refused for non-humans and other roles, for another organization's delivery, for a disabled subscription, and without the key", async () => {
      const failed = await failOnce();
      const noop = deps({ transport: fakeTransport() });
      await expect(WebhookDispatchService.replay({ ...owner, type: "API" }, failed.id, noop)).rejects.toThrow(PermissionDeniedError);
      await expect(WebhookDispatchService.replay({ ...owner, type: "AI" }, failed.id, noop)).rejects.toThrow(PermissionDeniedError);
      await expect(WebhookDispatchService.replay({ ...owner, role: "ACCOUNTANT" }, failed.id, noop)).rejects.toThrow(PermissionDeniedError);
      const other = await createTestOrg("wh-other");
      await expect(WebhookDispatchService.replay(other.owner, failed.id, noop)).rejects.toThrow(WebhookNotFoundError);
      await withTenant(orgId, (tx) => tx.update(webhookSubscriptions).set({ status: "DISABLED" }).where(eq(webhookSubscriptions.id, sub.subscription.id)));
      await expect(WebhookDispatchService.replay(owner, failed.id, noop)).rejects.toThrow(ReplayRefusedError);
      await withTenant(orgId, (tx) => tx.update(webhookSubscriptions).set({ status: "ACTIVE" }).where(eq(webhookSubscriptions.id, sub.subscription.id)));
      await expect(WebhookDispatchService.replay(owner, failed.id, { ...noop, env: {} })).rejects.toThrow(/disabled/);
      expect((noop.transport as ReturnType<typeof fakeTransport>).calls).toHaveLength(0);
    });
  });

  describe("send test event (ping)", () => {
    it("posts a signed ping to that subscription only, logged as TEST by the person, without touching the outbox fan-out or the breaker", async () => {
      const second = await makeSubscription(owner, { url: "https://second.example.com/x", eventTypes: ["invoice.created"] });
      const transport = fakeTransport();
      const outcome = await WebhookDispatchService.sendTestEvent(owner, sub.subscription.id, deps({ transport }));
      expect(outcome.success).toBe(true);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.url.hostname).toBe("hooks.example.com");
      const request = transport.calls[0]!;
      expect(request.headers["Mm-Event-Type"]).toBe("ping");
      const envelope = JSON.parse(request.body);
      expect(envelope).toMatchObject({ type: "ping", api_version: "v1", data: { object: { subscription_id: sub.subscription.id } } });
      expect(verifySignature(request.headers["Mm-Signature"]!, request.body, [sub.secret], Math.floor(clock.getTime() / 1000)).valid).toBe(true);

      const [ping] = await eventsOf(orgId, "ping");
      expect(ping!.dispatchedAt).not.toBeNull();
      expect((await attempts())[0]).toMatchObject({ trigger: "TEST", triggeredByUserId: owner.userId });

      // A later dispatch never offers the ping to anyone (no delivery for the second subscription).
      const later = await dispatch(deps({ transport }));
      expect(later).toMatchObject({ claimed: 0, deliveriesCreated: 0 });
      expect((await deliveries()).filter((d) => d.subscriptionId === second.subscription.id)).toHaveLength(0);
    });

    it("a failing endpoint shows the failure without counting toward the circuit breaker; refused for non-humans", async () => {
      const failing = fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.from("nope") }));
      const outcome = await WebhookDispatchService.sendTestEvent(owner, sub.subscription.id, deps({ transport: failing }));
      expect(outcome).toMatchObject({ success: false, deadLettered: false });
      expect((await deliveries())[0]).toMatchObject({ status: "FAILED", lastStatusCode: 500 });
      expect((await subRow()).consecutiveFailures).toBe(0);
      await expect(WebhookDispatchService.sendTestEvent({ ...owner, type: "API" }, sub.subscription.id, deps())).rejects.toThrow(PermissionDeniedError);
    });

    it("a test event to a private-resolving host is blocked and the client is never called", async () => {
      const transport = fakeTransport();
      const outcome = await WebhookDispatchService.sendTestEvent(owner, sub.subscription.id, deps({ transport, resolver: fakeResolver({ "hooks.example.com": ["10.0.0.1"] }) }));
      expect(outcome.result.errorClass).toBe("ssrf_blocked");
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe("secret rotation with overlap", () => {
    it("inside the grace window both signatures are present (new first); after it only the new one", async () => {
      const rotated = await WebhookSubscriptionService.rotateSecret(owner, sub.subscription.id, {}, clock);
      expect(rotated.secret).not.toBe(sub.secret);
      expect(rotated.previousSecretValidUntil.getTime()).toBe(clock.getTime() + 24 * 3_600_000);

      await newInvoice();
      const t1 = fakeTransport();
      clock = new Date(clock.getTime() + 3_600_000);
      await dispatch(deps({ transport: t1 }));
      const header = t1.calls[0]!.headers["Mm-Signature"]!;
      expect(header.match(/v1=/g)).toHaveLength(2);
      const nowSeconds = Math.floor(clock.getTime() / 1000);
      expect(verifySignature(header, t1.calls[0]!.body, [rotated.secret], nowSeconds).valid).toBe(true); // consumer on the NEW secret
      expect(verifySignature(header, t1.calls[0]!.body, [sub.secret], nowSeconds).valid).toBe(true); // consumer still on the OLD secret
      expect(header.indexOf(`v1=`)).toBeGreaterThan(0);

      await newInvoice();
      const t2 = fakeTransport();
      clock = new Date(clock.getTime() + 25 * 3_600_000);
      await dispatch(deps({ transport: t2 }));
      const later = t2.calls[0]!.headers["Mm-Signature"]!;
      expect(later.match(/v1=/g)).toHaveLength(1);
      const laterSeconds = Math.floor(clock.getTime() / 1000);
      expect(verifySignature(later, t2.calls[0]!.body, [rotated.secret], laterSeconds).valid).toBe(true);
      expect(verifySignature(later, t2.calls[0]!.body, [sub.secret], laterSeconds).valid).toBe(false);
    });

    it("rotating again inside the window replaces the old secret immediately (no third secret)", async () => {
      const first = await WebhookSubscriptionService.rotateSecret(owner, sub.subscription.id, {}, clock);
      const second = await WebhookSubscriptionService.rotateSecret(owner, sub.subscription.id, {}, clock);
      await newInvoice();
      const t = fakeTransport();
      await dispatch(deps({ transport: t }));
      const header = t.calls[0]!.headers["Mm-Signature"]!;
      const nowSeconds = Math.floor(clock.getTime() / 1000);
      expect(header.match(/v1=/g)).toHaveLength(2);
      expect(verifySignature(header, t.calls[0]!.body, [second.secret], nowSeconds).valid).toBe(true);
      expect(verifySignature(header, t.calls[0]!.body, [first.secret], nowSeconds).valid).toBe(true);
      expect(verifySignature(header, t.calls[0]!.body, [sub.secret], nowSeconds).valid).toBe(false);
    });
  });

  describe("fail closed without the key / with the wrong key", () => {
    it("dispatch does nothing at all without the encryption key (events stay safely in the outbox)", async () => {
      await newInvoice();
      const transport = fakeTransport();
      const result = await dispatch(deps({ transport, env: {} }));
      expect(result.skipped).toBe("encryption_not_configured");
      expect(transport.calls).toHaveLength(0);
      expect((await eventsOf(orgId, "invoice.created"))[0]!.dispatchedAt).toBeNull();
      expect(await deliveries()).toHaveLength(0);
    });

    it("a wrong key cannot decrypt the secret: the attempt is logged as secret_unavailable and nothing is sent", async () => {
      await newInvoice();
      const transport = fakeTransport();
      const wrong = Buffer.alloc(32, 9).toString("base64");
      expect(wrong).not.toBe(TEST_ENCRYPTION_KEY);
      await dispatch(deps({ transport, env: { WEBHOOK_SECRET_ENCRYPTION_KEY: wrong } }));
      expect(transport.calls).toHaveLength(0);
      expect((await attempts())[0]).toMatchObject({ errorClass: "secret_unavailable" });
      expect((await deliveries())[0]!.status).toBe("PENDING");
    });
  });

  describe("tenant isolation of the pipeline", () => {
    it("org A's dispatch never claims or sends org B's events; B's subscription never receives A's events", async () => {
      const b = await createTestOrg("wh-b");
      const salesB = await createSalesFixtures(b.owner, b.baseCurrency);
      const subB = await makeSubscription(b.owner, { url: "https://b.example.com/x", eventTypes: ["invoice.created"] });
      await InvoiceService.create(b.owner, { ...invoiceInput(), customerContactId: salesB.customerContactId, arAccountId: salesB.arAccountId, lines: [{ description: "B", quantity: "1", unitPrice: "5.00", accountId: salesB.revenueAccountId }] });
      await newInvoice();

      const transportA = fakeTransport();
      await dispatch(deps({ transport: transportA }));
      expect(transportA.calls.map((c) => c.url.hostname)).toEqual(["hooks.example.com"]);
      expect((await eventsOf(b.organizationId, "invoice.created"))[0]!.dispatchedAt).toBeNull(); // untouched by A's dispatch

      const transportB = fakeTransport();
      await WebhookDispatchService.dispatch(b.organizationId, { limit: 10 }, deps({ transport: transportB }));
      expect(transportB.calls.map((c) => c.url.hostname)).toEqual(["b.example.com"]);
      expect(JSON.stringify(transportB.calls.map((c) => c.body))).not.toContain(sales.customerContactId);
      void subB;
      // A's pending summary and delivery log see only A.
      expect((await listRecentDeliveries(owner, sub.subscription.id)).length).toBe(1);
      await expect(getDeliveryWithAttempts(b.owner, (await deliveries())[0]!.id)).rejects.toThrow(WebhookNotFoundError);
    });
  });

  describe("pending summary and the delivery log", () => {
    it("counts undispatched events, due deliveries, scheduled retries and dead letters with fixed SQL aggregates", async () => {
      await newInvoice();
      await newInvoice();
      expect(await pendingSummary(owner, clock)).toEqual({ undispatchedEvents: 2, dueNow: 0, scheduledLater: 0, failed: 0 });
      await dispatch(deps({ transport: fakeTransport((_r, n) => ({ status: n === 1 ? 200 : 500, bodyExcerpt: Buffer.alloc(0) })) }));
      expect(await pendingSummary(owner, clock)).toEqual({ undispatchedEvents: 0, dueNow: 0, scheduledLater: 1, failed: 0 });
      clock = new Date(clock.getTime() + 5 * 60_000);
      expect(await pendingSummary(owner, clock)).toMatchObject({ dueNow: 1, scheduledLater: 0 });
      await expect(pendingSummary({ ...owner, role: "READ_ONLY" }, clock)).rejects.toThrow(PermissionDeniedError);
    });

    it("lists recent deliveries and one delivery's attempt history (with who replayed it)", async () => {
      await newInvoice();
      await dispatch(deps({ transport: fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.from("e") })) }));
      const [row] = await deliveries();
      await WebhookDispatchService.replay(owner, row!.id, deps({ transport: fakeTransport() }));
      const list = await listRecentDeliveries(owner, sub.subscription.id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ eventType: "invoice.created", status: "DELIVERED", attemptCount: 2 });
      const detail = await getDeliveryWithAttempts(owner, row!.id);
      expect(detail.attempts.map((a) => [a.attemptNumber, a.trigger, a.statusCode])).toEqual([[1, "AUTO", 500], [2, "REPLAY", 200]]);
      expect(detail.attempts[1]!.triggeredByName).toBe("Owner");
    });
  });

  describe("retention", () => {
    it("lazily purges old, finished events (and their attempt logs by cascade) during dispatch, keeping recent and pending ones", async () => {
      const admin = new pg.Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await newInvoice();
        await dispatch(deps()); // delivered
        const oldEvent = (await eventsOf(orgId, "invoice.created"))[0]!;
        await admin.query(`UPDATE domain_events SET occurred_at = now() - interval '40 days' WHERE id = $1`, [oldEvent.id]);

        await newInvoice(); // recent, will stay
        const recentId = (await eventsOf(orgId, "invoice.created")).find((e) => e.id !== oldEvent.id)!.id;
        // An old event whose delivery is still PENDING must NOT be purged.
        await newInvoice();
        const pendingEvent = (await eventsOf(orgId, "invoice.created")).find((e) => e.id !== oldEvent.id && e.id !== recentId)!;
        await dispatch(deps({ transport: fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.alloc(0) })) }));
        await admin.query(`UPDATE domain_events SET occurred_at = now() - interval '40 days' WHERE id = $1`, [pendingEvent.id]);

        // The purge runs at most once an hour per organization in a process; use a fresh organization-keyed run by moving the clock.
        clock = new Date(Date.now() + 2 * 3_600_000);
        await dispatch(deps({ transport: fakeTransport(() => ({ status: 500, bodyExcerpt: Buffer.alloc(0) })) }));
        const remaining = (await eventsOf(orgId, "invoice.created")).map((e) => e.id);
        expect(remaining).not.toContain(oldEvent.id);
        expect(remaining).toContain(recentId);
        expect(remaining).toContain(pendingEvent.id);
        const orphanAttempts = await admin.query(`SELECT count(*)::int AS n FROM webhook_delivery_attempts a WHERE NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.id = a.delivery_id)`);
        expect(orphanAttempts.rows[0].n).toBe(0);
        const oldAttempts = await admin.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE event_id = $1`, [oldEvent.id]);
        expect(oldAttempts.rows[0].n).toBe(0);
      } finally {
        await admin.end();
      }
    });
  });

  describe("best-effort dispatch after the response", () => {
    it("scheduleDispatchAfterResponse dispatches in the background, once per organization at a time, and never throws", async () => {
      await newInvoice();
      const transport = fakeTransport(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { status: 200, bodyExcerpt: Buffer.from("ok") };
      });
      configurePostResponseDispatch({ enabled: true, deps: deps({ transport }) });
      const first = scheduleDispatchAfterResponse(orgId);
      const second = scheduleDispatchAfterResponse(orgId); // already running: skipped, resolves immediately
      await second;
      expect(transport.calls.length).toBeLessThanOrEqual(1);
      await first;
      expect(transport.calls).toHaveLength(1);
      expect((await deliveries())[0]!.status).toBe("DELIVERED");

      // A dispatch that blows up inside is swallowed.
      configurePostResponseDispatch({ enabled: true, deps: { ...deps(), now: () => { throw new Error("clock exploded"); } } });
      await expect(scheduleDispatchAfterResponse(orgId)).resolves.toBeUndefined();
      // Disabled (the default under test) and key-less modes do nothing.
      configurePostResponseDispatch({ enabled: false, deps: deps({ transport }) });
      await newInvoice();
      await scheduleDispatchAfterResponse(orgId);
      expect(transport.calls).toHaveLength(1);
      configurePostResponseDispatch({ enabled: true, deps: deps({ transport, env: {} }) });
      await scheduleDispatchAfterResponse(orgId);
      expect(transport.calls).toHaveLength(1);
    });

    it("end to end: an invoice created through the public API is delivered right after the response, over the fake HTTP client", async () => {
      const transport = fakeTransport();
      configurePostResponseDispatch({ enabled: true, deps: { resolver: fakeResolver(), transport, random: () => 0.5 } });
      const key = (await makeKey(owner, ["invoices:write", "invoices:read"], { rateLimitPerMinute: 600 })).secret;
      const res = await post("/invoices", key, { customer_id: sales.customerContactId, issue_date: "2026-03-10", due_date: "2026-04-10", currency: "AUD", ar_account_id: sales.arAccountId, lines: [{ description: "x", quantity: "1", unit_price: "10.00", account_id: sales.revenueAccountId }] }, { idempotencyKey: "wh-e2e-1" });
      expect(res.status).toBe(201);
      // The response has been returned; the dispatch runs behind it.
      for (let i = 0; i < 100 && transport.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.headers["Mm-Event-Type"]).toBe("invoice.created");
      expect(JSON.parse(transport.calls[0]!.body).data.object.id).toBe(res.body.data.id);
      // An idempotent replay of the same request creates no second event and schedules nothing new.
      const replay = await post("/invoices", key, { customer_id: sales.customerContactId, issue_date: "2026-03-10", due_date: "2026-04-10", currency: "AUD", ar_account_id: sales.arAccountId, lines: [{ description: "x", quantity: "1", unit_price: "10.00", account_id: sales.revenueAccountId }] }, { idempotencyKey: "wh-e2e-1" });
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      await new Promise((r) => setTimeout(r, 100));
      expect(transport.calls).toHaveLength(1);
      expect((await eventsOf(orgId, "invoice.created")).filter((e) => (e.payload as { data: { object: { id: string } } }).data.object.id === res.body.data.id)).toHaveLength(1);
      void call;
      void and;
    });
  });
});
