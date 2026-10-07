import { and, asc, desc, eq, sql } from "drizzle-orm";
import { domainEvents, users, webhookDeliveries, webhookDeliveryAttempts, webhookSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { Actor } from "@/domain/permissions/permission-service";
import { WebhookNotFoundError, assertHumanWebhookManager } from "./subscription-service";

/**
 * Read side of the delivery log, for the settings UI. Same gate as the management service (`webhook:manage`, human only):
 * the log contains customer-endpoint response excerpts. Each function is ONE tenant transaction with a fixed, small number
 * of statements (counts are aggregated in SQL).
 */
export interface PendingSummary {
  /** Events committed but not yet fanned out into deliveries. */
  undispatchedEvents: number;
  /** Deliveries that are due right now (a "Send now" would send them). */
  dueNow: number;
  /** Deliveries waiting out a retry backoff. */
  scheduledLater: number;
  /** Dead letters: automatic attempts exhausted. Replayable by hand. */
  failed: number;
}

export async function pendingSummary(actor: Actor, now: Date = new Date()): Promise<PendingSummary> {
  assertHumanWebhookManager(actor);
  return withTenant(actor.organizationId, async (tx) => {
    const [events] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(domainEvents)
      .where(and(eq(domainEvents.organizationId, actor.organizationId), sql`${domainEvents.dispatchedAt} IS NULL`));
    const [deliveries] = await tx
      .select({
        dueNow: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'PENDING' AND ${webhookDeliveries.nextAttemptAt} <= ${now} AND (${webhookDeliveries.leaseUntil} IS NULL OR ${webhookDeliveries.leaseUntil} <= ${now}))::int`,
        scheduledLater: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'PENDING' AND ${webhookDeliveries.nextAttemptAt} > ${now})::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${webhookDeliveries.status} = 'FAILED')::int`,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.organizationId, actor.organizationId));
    return {
      undispatchedEvents: events?.n ?? 0,
      dueNow: deliveries?.dueNow ?? 0,
      scheduledLater: deliveries?.scheduledLater ?? 0,
      failed: deliveries?.failed ?? 0,
    };
  });
}

export interface DeliveryListItem {
  id: string;
  eventId: string;
  eventType: string;
  status: "PENDING" | "DELIVERED" | "FAILED";
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

export const RECENT_DELIVERIES_LIMIT = 20;

export async function listRecentDeliveries(actor: Actor, subscriptionId: string, limit: number = RECENT_DELIVERIES_LIMIT): Promise<DeliveryListItem[]> {
  assertHumanWebhookManager(actor);
  return withTenant(actor.organizationId, async (tx) => {
    const rows = await tx
      .select({
        id: webhookDeliveries.id,
        eventId: webhookDeliveries.eventId,
        eventType: domainEvents.type,
        status: webhookDeliveries.status,
        attemptCount: webhookDeliveries.attemptCount,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(domainEvents, eq(domainEvents.id, webhookDeliveries.eventId))
      .where(and(eq(webhookDeliveries.organizationId, actor.organizationId), eq(webhookDeliveries.subscriptionId, subscriptionId)))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows;
  });
}

export interface AttemptItem {
  attemptNumber: number;
  trigger: string;
  startedAt: Date;
  durationMs: number;
  statusCode: number | null;
  errorClass: string | null;
  responseExcerpt: string | null;
  triggeredByName: string | null;
}

export async function getDeliveryWithAttempts(actor: Actor, deliveryId: string) {
  assertHumanWebhookManager(actor);
  return withTenant(actor.organizationId, async (tx) => {
    const [delivery] = await tx
      .select({
        id: webhookDeliveries.id,
        subscriptionId: webhookDeliveries.subscriptionId,
        subscriptionUrl: webhookSubscriptions.url,
        eventId: webhookDeliveries.eventId,
        eventType: domainEvents.type,
        status: webhookDeliveries.status,
        attemptCount: webhookDeliveries.attemptCount,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
      .innerJoin(domainEvents, eq(domainEvents.id, webhookDeliveries.eventId))
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organizationId, actor.organizationId)));
    if (!delivery) throw new WebhookNotFoundError();
    const attempts = await tx
      .select({
        attemptNumber: webhookDeliveryAttempts.attemptNumber,
        trigger: webhookDeliveryAttempts.trigger,
        startedAt: webhookDeliveryAttempts.startedAt,
        durationMs: webhookDeliveryAttempts.durationMs,
        statusCode: webhookDeliveryAttempts.statusCode,
        errorClass: webhookDeliveryAttempts.errorClass,
        responseExcerpt: webhookDeliveryAttempts.responseExcerpt,
        triggeredByName: users.name,
      })
      .from(webhookDeliveryAttempts)
      .leftJoin(users, eq(users.id, webhookDeliveryAttempts.triggeredByUserId))
      .where(and(eq(webhookDeliveryAttempts.deliveryId, deliveryId), eq(webhookDeliveryAttempts.organizationId, actor.organizationId)))
      .orderBy(asc(webhookDeliveryAttempts.attemptNumber), asc(webhookDeliveryAttempts.createdAt))
      .limit(100);
    return { delivery, attempts: attempts as AttemptItem[] };
  });
}
