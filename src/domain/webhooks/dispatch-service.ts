import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { domainEvents, webhookDeliveries, webhookDeliveryAttempts, webhookSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { CIRCUIT_BREAKER_THRESHOLD, nextAttemptAt } from "./backoff";
import { PING_EVENT_TYPE, WEBHOOK_API_VERSION, type EventEnvelope } from "./events";
import { sendWebhook, USER_AGENT, DELIVERY_TIMEOUT_MS, type OutboundDeps, type OutboundResult } from "./outbound";
import { SecretDecryptionError, decryptSecret, loadKeyring, type Keyring } from "./secret-crypto";
import { sanitiseError } from "./sanitize";
import { SIGNATURE_HEADER, buildSignatureHeader } from "./signing";
import { WebhookNotFoundError, assertHumanWebhookManager } from "./subscription-service";

/**
 * Fan-out, delivery, retry, replay and the test ping (docs/architecture.md section 11, docs/api.md "Webhooks").
 *
 * CONNECTION DISCIPLINE (a production incident was fixed for this): no database transaction or connection is open while an
 * HTTP request is in flight, and nothing here ever uses Promise.all. A dispatch is
 *
 *   phase A   ONE short transaction: try-lock, fan undispatched events out into per-subscription delivery rows,
 *             claim due deliveries with FOR UPDATE SKIP LOCKED and stamp a lease on them, COMMIT;
 *   send      for each claimed delivery, SEQUENTIALLY, with NO transaction open: decrypt, sign, POST via the SSRF-guarded
 *             client;
 *   phase B   per delivery, ONE short transaction: append the attempt row, move the delivery to its next state, update
 *             the subscription's failure counter (the circuit breaker).
 *
 * Delivery is AT LEAST ONCE: a process that dies between "send" and "phase B" leaves a lease that simply expires, after
 * which the delivery is due again. Consumers must dedupe on the event id.
 *
 * `dispatch` is the single entry point a scheduler could later be pointed at (one call per organization with pending
 * work). There is deliberately no global cross-tenant dispatcher in this slice: finding "which organizations have work"
 * needs a cross-tenant index that the row-level-security model does not allow the application role to read.
 */
export const DEFAULT_BATCH_LIMIT = 10;
export const MAX_BATCH_LIMIT = 10;
const FANOUT_BATCH = 50;
/** A subscription receives events from (its creation time - this skew); absorbs small app/database clock differences. */
const SUBSCRIPTION_SKEW_MS = 5_000;
const LEASE_SAFETY_MS = 30_000;
export const RETENTION_DAYS = 30;
const PURGE_BATCH = 200;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const lastPurgeAt = new Map<string, number>();

export type AttemptTrigger = "AUTO" | "REPLAY" | "TEST";

export interface DispatchDeps extends OutboundDeps {
  /** Overrides the encryption environment (tests). */
  env?: Record<string, string | undefined>;
  random?: () => number;
  now?: () => Date;
  /** Jest-style hook: called with the number of transactions that are open at the instant the HTTP client runs (tests). */
  onSend?: () => void;
}

export interface DispatchResult {
  skipped: "encryption_not_configured" | null;
  eventsFannedOut: number;
  deliveriesCreated: number;
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

interface Claim {
  deliveryId: string;
  organizationId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  subscriptionId: string;
  url: string;
  secretCiphertext: string;
  previousSecretCiphertext: string | null;
  previousSecretExpiresAt: Date | null;
  attemptNumber: number;
  autoAttempts: number;
  leaseUntil: Date;
}

const emptyResult = (skipped: DispatchResult["skipped"] = null): DispatchResult => ({
  skipped,
  eventsFannedOut: 0,
  deliveriesCreated: 0,
  claimed: 0,
  delivered: 0,
  failed: 0,
  deadLettered: 0,
});

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? DEFAULT_BATCH_LIMIT);
  return Math.min(Math.max(n, 1), MAX_BATCH_LIMIT);
}

/** Lease long enough that the LAST delivery of a batch is still protected when its turn comes. */
function leaseFor(now: Date, batch: number): Date {
  return new Date(now.getTime() + batch * DELIVERY_TIMEOUT_MS + LEASE_SAFETY_MS);
}

/** Builds the exact request for one claimed delivery: raw body, signature over it, and the identifying headers. */
export function buildDeliveryRequest(claim: Claim, keyring: Keyring, now: Date) {
  const context = { organizationId: claim.organizationId, subscriptionId: claim.subscriptionId };
  const secrets = [decryptSecret(claim.secretCiphertext, context, keyring)];
  if (claim.previousSecretCiphertext && claim.previousSecretExpiresAt && claim.previousSecretExpiresAt.getTime() > now.getTime()) {
    secrets.push(decryptSecret(claim.previousSecretCiphertext, context, keyring));
  }
  const body = JSON.stringify(claim.payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    url: claim.url,
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "Mm-Event-Id": claim.eventId,
      "Mm-Delivery-Id": claim.deliveryId,
      "Mm-Event-Type": claim.eventType,
      "Mm-Subscription-Id": claim.subscriptionId,
      "Mm-Delivery-Attempt": String(claim.attemptNumber),
      [SIGNATURE_HEADER]: buildSignatureHeader(secrets, timestamp, body),
    } as Record<string, string>,
  };
}

/** Sends one claimed delivery and records the outcome. NO transaction is open during the send. Never throws. */
async function attemptAndRecord(
  claim: Claim,
  keyring: Keyring,
  trigger: AttemptTrigger,
  triggeredByUserId: string | null,
  deps: DispatchDeps,
): Promise<{ success: boolean; deadLettered: boolean; result: OutboundResult }> {
  const startedAt = (deps.now ?? (() => new Date()))();
  let result: OutboundResult;
  try {
    const request = buildDeliveryRequest(claim, keyring, startedAt);
    deps.onSend?.();
    result = await sendWebhook(request, deps);
  } catch (error) {
    // Only a secret that cannot be decrypted lands here (the client itself never throws).
    const message = error instanceof SecretDecryptionError ? "The signing secret could not be decrypted." : "Unexpected error while preparing the delivery.";
    result = { success: false, statusCode: null, errorClass: "secret_unavailable", errorMessage: sanitiseError(message), excerpt: null, durationMs: 0 };
  }
  const recorded = await recordOutcome(claim, result, trigger, triggeredByUserId, startedAt, deps);
  return { success: result.success, deadLettered: recorded.deadLettered, result };
}

async function recordOutcome(
  claim: Claim,
  result: OutboundResult,
  trigger: AttemptTrigger,
  triggeredByUserId: string | null,
  startedAt: Date,
  deps: DispatchDeps,
): Promise<{ deadLettered: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    return await withTenant(claim.organizationId, async (tx) => {
      await tx.insert(webhookDeliveryAttempts).values({
        organizationId: claim.organizationId,
        deliveryId: claim.deliveryId,
        attemptNumber: claim.attemptNumber,
        trigger,
        triggeredByUserId,
        startedAt,
        durationMs: Math.min(result.durationMs, 2_000_000_000),
        statusCode: result.statusCode,
        errorClass: result.errorClass,
        responseExcerpt: result.excerpt,
      });

      let deadLettered = false;
      const base = {
        attemptCount: claim.attemptNumber,
        lastStatusCode: result.statusCode,
        lastError: result.success ? null : (result.errorMessage ?? result.errorClass),
        lastAttemptAt: now,
        leaseUntil: null as Date | null,
      };
      // Compare-and-set on the lease we hold: if it expired and someone else re-claimed the delivery, the attempt is
      // still logged (it happened) but the state machine is theirs to move.
      const holdsLease = and(eq(webhookDeliveries.id, claim.deliveryId), eq(webhookDeliveries.leaseUntil, claim.leaseUntil));

      if (result.success) {
        await tx
          .update(webhookDeliveries)
          .set({ ...base, status: "DELIVERED", deliveredAt: now, nextAttemptAt: null, autoAttempts: trigger === "AUTO" ? claim.autoAttempts + 1 : claim.autoAttempts })
          .where(holdsLease);
      } else if (trigger === "AUTO") {
        const autoAttempts = claim.autoAttempts + 1;
        const next = nextAttemptAt(now, autoAttempts, deps.random);
        deadLettered = next === null;
        await tx
          .update(webhookDeliveries)
          .set({ ...base, autoAttempts, status: next ? "PENDING" : "FAILED", nextAttemptAt: next })
          .where(holdsLease);
      } else if (trigger === "TEST") {
        await tx.update(webhookDeliveries).set({ ...base, status: "FAILED", nextAttemptAt: null }).where(holdsLease);
      } else {
        // REPLAY failure never degrades the delivery: status and schedule stay as they were; only the "last" fields move.
        await tx.update(webhookDeliveries).set(base).where(holdsLease);
      }

      // The circuit breaker counts AUTOMATIC failures; any real success (automatic or replayed) resets it. A test ping does neither.
      if (trigger !== "TEST") {
        if (result.success) {
          await tx
            .update(webhookSubscriptions)
            .set({ consecutiveFailures: 0, lastSuccessAt: now })
            .where(eq(webhookSubscriptions.id, claim.subscriptionId));
        } else if (trigger === "AUTO") {
          const [sub] = await tx
            .update(webhookSubscriptions)
            .set({ consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`, lastFailureAt: now })
            .where(eq(webhookSubscriptions.id, claim.subscriptionId))
            .returning({ failures: webhookSubscriptions.consecutiveFailures, status: webhookSubscriptions.status, createdBy: webhookSubscriptions.createdByUserId, url: webhookSubscriptions.url });
          if (sub && sub.status === "ACTIVE" && sub.failures >= CIRCUIT_BREAKER_THRESHOLD) {
            const reason = `Automatically disabled after ${sub.failures} consecutive failed deliveries. Fix the endpoint, then re-enable it.`;
            await tx
              .update(webhookSubscriptions)
              .set({ status: "DISABLED", statusReason: reason, updatedAt: now })
              .where(and(eq(webhookSubscriptions.id, claim.subscriptionId), eq(webhookSubscriptions.status, "ACTIVE")));
            const system: Actor = { userId: sub.createdBy, organizationId: claim.organizationId, role: "OWNER", type: "SYSTEM" };
            await AuditService.record(tx, system, {
              action: "webhook_subscription.auto_disabled",
              entityType: "WebhookSubscription",
              entityId: claim.subscriptionId,
              before: { status: "ACTIVE" },
              after: { status: "DISABLED", statusReason: reason, consecutiveFailures: sub.failures },
            });
          }
        }
      }
      return { deadLettered };
    });
  } catch {
    // The subscription (or its delivery) was deleted while the request was in flight, or the database is unavailable. The
    // lease on the row expires by itself; there is nothing safe to do here and nothing may throw into the caller.
    return { deadLettered: false };
  }
}

export const WebhookDispatchService = {
  /**
   * Dispatches pending work for ONE organization: fan-out, claim, send (sequentially), record. Bounded by `limit` (<= 10).
   * Safe to call concurrently and repeatedly: fan-out is idempotent (unique event x subscription) and claims use
   * FOR UPDATE SKIP LOCKED plus a lease, so two dispatchers never send the same delivery. Never throws on a delivery failure.
   */
  async dispatch(organizationId: string, options: { limit?: number } = {}, deps: DispatchDeps = {}): Promise<DispatchResult> {
    const keyringResult = loadKeyring(deps.env ?? process.env);
    if (!keyringResult.ok) return emptyResult("encryption_not_configured");
    const keyring = keyringResult.keyring;
    const limit = clampLimit(options.limit);
    const now = (deps.now ?? (() => new Date()))();
    const result = emptyResult();

    // ---- phase A: one short transaction ------------------------------------------------------------------------------
    const claims = await withTenant(organizationId, async (tx) => {
      const [{ got } = { got: false }] = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`webhook-fanout:${organizationId}`})) AS got`,
      )).rows as { got: boolean }[];

      if (got) {
        if (!lastPurgeAt.has(organizationId) || now.getTime() - (lastPurgeAt.get(organizationId) as number) > PURGE_INTERVAL_MS) {
          lastPurgeAt.set(organizationId, now.getTime());
          const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
          await tx.execute(sql`
            DELETE FROM domain_events WHERE id IN (
              SELECT e.id FROM domain_events e
              WHERE e.organization_id = ${organizationId} AND e.occurred_at < ${cutoff} AND e.dispatched_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = e.id AND d.status = 'PENDING')
              LIMIT ${PURGE_BATCH})`);
        }

        const events = await tx
          .select({ id: domainEvents.id, type: domainEvents.type, occurredAt: domainEvents.occurredAt })
          .from(domainEvents)
          .where(and(eq(domainEvents.organizationId, organizationId), isNull(domainEvents.dispatchedAt)))
          .orderBy(asc(domainEvents.occurredAt))
          .limit(FANOUT_BATCH)
          .for("update", { skipLocked: true });
        if (events.length > 0) {
          const subs = await tx
            .select({ id: webhookSubscriptions.id, eventTypes: webhookSubscriptions.eventTypes, createdAt: webhookSubscriptions.createdAt })
            .from(webhookSubscriptions)
            .where(and(eq(webhookSubscriptions.organizationId, organizationId), eq(webhookSubscriptions.status, "ACTIVE")));
          const rows = events.flatMap((e) =>
            subs
              .filter((s) => s.eventTypes.includes(e.type) && s.createdAt.getTime() - SUBSCRIPTION_SKEW_MS <= e.occurredAt.getTime())
              .map((s) => ({ organizationId, eventId: e.id, subscriptionId: s.id, nextAttemptAt: now })),
          );
          if (rows.length > 0) {
            const inserted = await tx.insert(webhookDeliveries).values(rows).onConflictDoNothing().returning({ id: webhookDeliveries.id });
            result.deliveriesCreated = inserted.length;
          }
          await tx
            .update(domainEvents)
            .set({ dispatchedAt: now })
            .where(and(eq(domainEvents.organizationId, organizationId), inArray(domainEvents.id, events.map((e) => e.id))));
          result.eventsFannedOut = events.length;
        }
      }

      const due = await tx
        .select({
          deliveryId: webhookDeliveries.id,
          eventId: webhookDeliveries.eventId,
          eventType: domainEvents.type,
          payload: domainEvents.payload,
          subscriptionId: webhookDeliveries.subscriptionId,
          url: webhookSubscriptions.url,
          secretCiphertext: webhookSubscriptions.secretCiphertext,
          previousSecretCiphertext: webhookSubscriptions.previousSecretCiphertext,
          previousSecretExpiresAt: webhookSubscriptions.previousSecretExpiresAt,
          attemptCount: webhookDeliveries.attemptCount,
          autoAttempts: webhookDeliveries.autoAttempts,
        })
        .from(webhookDeliveries)
        .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
        .innerJoin(domainEvents, eq(domainEvents.id, webhookDeliveries.eventId))
        .where(
          and(
            eq(webhookDeliveries.organizationId, organizationId),
            eq(webhookDeliveries.status, "PENDING"),
            eq(webhookSubscriptions.status, "ACTIVE"),
            lte(webhookDeliveries.nextAttemptAt, now),
            or(isNull(webhookDeliveries.leaseUntil), lte(webhookDeliveries.leaseUntil, now)),
          ),
        )
        .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
        .limit(limit)
        // Rows another dispatcher has locked are skipped, never waited for: two dispatchers never claim the same delivery.
        .for("update", { of: webhookDeliveries, skipLocked: true });
      if (due.length === 0) return [] as Claim[];

      const lease = leaseFor(now, due.length);
      await tx.update(webhookDeliveries).set({ leaseUntil: lease }).where(inArray(webhookDeliveries.id, due.map((d) => d.deliveryId)));
      return due.map<Claim>((d) => ({
        deliveryId: d.deliveryId,
        organizationId,
        eventId: d.eventId,
        eventType: d.eventType,
        payload: d.payload,
        subscriptionId: d.subscriptionId,
        url: d.url,
        secretCiphertext: d.secretCiphertext,
        previousSecretCiphertext: d.previousSecretCiphertext,
        previousSecretExpiresAt: d.previousSecretExpiresAt,
        attemptNumber: d.attemptCount + 1,
        autoAttempts: d.autoAttempts,
        leaseUntil: lease,
      }));
    });
    result.claimed = claims.length;

    // ---- send + phase B, one delivery at a time, no transaction held while the request is in flight -------------------
    for (const claim of claims) {
      const outcome = await attemptAndRecord(claim, keyring, "AUTO", null, deps);
      if (outcome.success) result.delivered += 1;
      else result.failed += 1;
      if (outcome.deadLettered) result.deadLettered += 1;
    }
    return result;
  },

  /** "Send pending / retry failed now": a human triggers one bounded dispatch for their organization. */
  async dispatchNow(actor: Actor, deps: DispatchDeps = {}): Promise<DispatchResult> {
    assertHumanWebhookManager(actor);
    return this.dispatch(actor.organizationId, { limit: MAX_BATCH_LIMIT }, deps);
  },

  /** Replays ONE delivery now (any status), as a fresh attempt logged as a REPLAY by the acting person. */
  async replay(actor: Actor, deliveryId: string, deps: DispatchDeps = {}) {
    assertHumanWebhookManager(actor);
    const keyringResult = loadKeyring(deps.env ?? process.env);
    if (!keyringResult.ok) throw new ReplayRefusedError(`Webhooks are disabled: ${keyringResult.reason}`);
    const now = (deps.now ?? (() => new Date()))();

    const claim = await withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          deliveryId: webhookDeliveries.id,
          eventId: webhookDeliveries.eventId,
          eventType: domainEvents.type,
          payload: domainEvents.payload,
          subscriptionId: webhookDeliveries.subscriptionId,
          subStatus: webhookSubscriptions.status,
          url: webhookSubscriptions.url,
          secretCiphertext: webhookSubscriptions.secretCiphertext,
          previousSecretCiphertext: webhookSubscriptions.previousSecretCiphertext,
          previousSecretExpiresAt: webhookSubscriptions.previousSecretExpiresAt,
          attemptCount: webhookDeliveries.attemptCount,
          autoAttempts: webhookDeliveries.autoAttempts,
          leaseUntil: webhookDeliveries.leaseUntil,
          status: webhookDeliveries.status,
        })
        .from(webhookDeliveries)
        .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
        .innerJoin(domainEvents, eq(domainEvents.id, webhookDeliveries.eventId))
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organizationId, actor.organizationId)))
        .for("update", { of: webhookDeliveries });
      if (!row) throw new WebhookNotFoundError();
      if (row.subStatus === "DISABLED") throw new ReplayRefusedError("This subscription is disabled. Re-enable it before replaying.");
      if (row.leaseUntil && row.leaseUntil.getTime() > now.getTime()) throw new ReplayRefusedError("This delivery is being sent right now. Try again in a moment.");

      const lease = leaseFor(now, 1);
      await tx.update(webhookDeliveries).set({ leaseUntil: lease }).where(eq(webhookDeliveries.id, deliveryId));
      await AuditService.record(tx, actor, {
        action: "webhook_delivery.replayed",
        entityType: "WebhookDelivery",
        entityId: deliveryId,
        before: { status: row.status },
        after: { eventId: row.eventId, subscriptionId: row.subscriptionId },
      });
      return {
        deliveryId,
        organizationId: actor.organizationId,
        eventId: row.eventId,
        eventType: row.eventType,
        payload: row.payload,
        subscriptionId: row.subscriptionId,
        url: row.url,
        secretCiphertext: row.secretCiphertext,
        previousSecretCiphertext: row.previousSecretCiphertext,
        previousSecretExpiresAt: row.previousSecretExpiresAt,
        attemptNumber: row.attemptCount + 1,
        autoAttempts: row.autoAttempts,
        leaseUntil: lease,
      } satisfies Claim;
    });

    return attemptAndRecord(claim, keyringResult.keyring, "REPLAY", actor.userId, deps);
  },

  /**
   * "Send test event": posts a signed `ping` to one subscription so a person can verify their endpoint and signature
   * handling. The ping is stored as an outbox event flagged `ping` and pre-marked dispatched (fan-out never touches it),
   * so it appears in the delivery log but is never offered to any other subscription and never trips the circuit breaker.
   */
  async sendTestEvent(actor: Actor, subscriptionId: string, deps: DispatchDeps = {}) {
    assertHumanWebhookManager(actor);
    const keyringResult = loadKeyring(deps.env ?? process.env);
    if (!keyringResult.ok) throw new ReplayRefusedError(`Webhooks are disabled: ${keyringResult.reason}`);
    const now = (deps.now ?? (() => new Date()))();

    const claim = await withTenant(actor.organizationId, async (tx) => {
      const [sub] = await tx
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, actor.organizationId)));
      if (!sub) throw new WebhookNotFoundError();
      if (sub.status === "DISABLED") throw new ReplayRefusedError("This subscription is disabled. Re-enable it before sending a test event.");

      const eventId = randomUUID();
      const envelope: EventEnvelope = {
        id: eventId,
        type: PING_EVENT_TYPE,
        api_version: WEBHOOK_API_VERSION,
        created_at: now.toISOString(),
        data: { object: { message: "This is a test event from Money Matters.", subscription_id: subscriptionId } },
      };
      await tx.insert(domainEvents).values({
        id: eventId,
        organizationId: actor.organizationId,
        type: PING_EVENT_TYPE,
        aggregateType: "WebhookSubscription",
        aggregateId: subscriptionId,
        payload: envelope,
        occurredAt: now,
        dispatchedAt: now,
      });
      const lease = leaseFor(now, 1);
      const [delivery] = await tx
        .insert(webhookDeliveries)
        .values({ organizationId: actor.organizationId, eventId, subscriptionId, status: "PENDING", nextAttemptAt: null, leaseUntil: lease })
        .returning({ id: webhookDeliveries.id });
      if (!delivery) throw new Error("Failed to create the test delivery.");
      await AuditService.record(tx, actor, {
        action: "webhook_subscription.test_sent",
        entityType: "WebhookSubscription",
        entityId: subscriptionId,
        after: { eventId },
      });
      return {
        deliveryId: delivery.id,
        organizationId: actor.organizationId,
        eventId,
        eventType: PING_EVENT_TYPE,
        payload: envelope,
        subscriptionId,
        url: sub.url,
        secretCiphertext: sub.secretCiphertext,
        previousSecretCiphertext: sub.previousSecretCiphertext,
        previousSecretExpiresAt: sub.previousSecretExpiresAt,
        attemptNumber: 1,
        autoAttempts: 0,
        leaseUntil: lease,
      } satisfies Claim;
    });

    return attemptAndRecord(claim, keyringResult.keyring, "TEST", actor.userId, deps);
  },
};

export class ReplayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRefusedError";
  }
}
