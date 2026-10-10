import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { users, webhookSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { EVENT_TYPES, isWebhookEventType, type WebhookEventType } from "./events";
import { classifyAddress } from "./ip-classifier";
import { encryptSecret, requireKeyring } from "./secret-crypto";
import { generateSigningSecret } from "./signing";
import { parseWebhookUrl, resolveAndVet, systemResolver, type AddressClassifier, type Resolver } from "./url-guard";

/**
 * Management of webhook subscriptions - the human side of webhooks. Gated on `webhook:manage` (OWNER / ADMINISTRATOR only)
 * AND on the actor being a HUMAN: an AI, system or API-key actor is refused structurally, so an integration can never
 * point the platform at a URL of its choosing (and no AI controller tool touches this service).
 *
 * The signing secret is returned by `create` and `rotateSecret` exactly once. At rest it is AES-256-GCM ciphertext; it is
 * never returned by `list`, never written to the audit log and never logged. Every mutation is audited in the same
 * transaction. Network I/O (the DNS check of the URL) happens BEFORE the transaction opens, never inside it.
 */
export class WebhookNotFoundError extends Error {
  constructor() {
    super("Webhook subscription not found in this organization.");
    this.name = "WebhookNotFoundError";
  }
}

export class InvalidWebhookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookInputError";
  }
}

export const MAX_SUBSCRIPTIONS_PER_ORG = 10;
export const MAX_DESCRIPTION_LENGTH = 200;
/** After a rotation the previous secret keeps signing deliveries (alongside the new one) for this long. */
export const ROTATION_GRACE_HOURS = 24;

export type WebhookSubscriptionStatus = "ACTIVE" | "PAUSED" | "DISABLED";

export interface WebhookSubscriptionSummary {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: WebhookSubscriptionStatus;
  statusReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
  /** True while the previous secret is still accepted alongside the new one. */
  rotationGraceUntil: Date | null;
}

export interface GuardDeps {
  resolver?: Resolver;
  classify?: AddressClassifier;
}

export function assertHumanWebhookManager(actor: Actor): void {
  assertPermission(actor, "webhook:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("webhook:manage", actor.role);
}

/** Validates the closed list of event types: non-empty, known, no wildcard, de-duplicated, in catalogue order. */
export function normaliseEventTypes(input: readonly string[]): WebhookEventType[] {
  const wanted = new Set<string>();
  for (const raw of input) {
    const type = raw.trim();
    if (type === "*" || type.includes("*")) throw new InvalidWebhookInputError("Wildcard subscriptions are not supported - choose the event types you want.");
    if (!isWebhookEventType(type)) throw new InvalidWebhookInputError(`"${type}" is not an event type. Choose from the list.`);
    wanted.add(type);
  }
  if (wanted.size === 0) throw new InvalidWebhookInputError("Choose at least one event type.");
  return EVENT_TYPES.filter((t) => wanted.has(t));
}

/** Static + DNS validation of a subscription URL, run BEFORE any transaction. Throws a friendly error when refused. */
export async function assertDeliverableUrl(rawUrl: string, deps: GuardDeps = {}): Promise<string> {
  const verdict = parseWebhookUrl(rawUrl);
  if (!verdict.ok) throw new InvalidWebhookInputError(verdict.reason);
  const vet = await resolveAndVet(verdict, deps.resolver ?? systemResolver, deps.classify ?? classifyAddress);
  if (!vet.ok) {
    throw new InvalidWebhookInputError(
      vet.errorClass === "ssrf_blocked"
        ? `That host is not allowed: it ${vet.reason}. Webhooks can only be sent to public internet addresses.`
        : `We could not look that host up (${vet.reason}). Check the address and try again.`,
    );
  }
  // Canonical form without fragment/default port; the exact text the customer will see and we will post to.
  return verdict.url.toString();
}

function cleanDescription(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (text.length === 0) return null;
  if (text.length > MAX_DESCRIPTION_LENGTH) throw new InvalidWebhookInputError(`The description may be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  return text;
}

type SubscriptionRow = typeof webhookSubscriptions.$inferSelect;

function summarise(row: SubscriptionRow, createdByName: string | null, now: Date): WebhookSubscriptionSummary {
  const graceActive = row.previousSecretCiphertext && row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > now.getTime();
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes,
    status: row.status,
    statusReason: row.statusReason,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdAt: row.createdAt,
    createdByName,
    rotationGraceUntil: graceActive ? row.previousSecretExpiresAt : null,
  };
}

/** Audit-safe view of a subscription: never any secret material. */
function auditView(row: Pick<SubscriptionRow, "url" | "description" | "eventTypes" | "status" | "statusReason">) {
  return { url: row.url, description: row.description, eventTypes: row.eventTypes, status: row.status, statusReason: row.statusReason };
}

export const WebhookSubscriptionService = {
  async create(
    actor: Actor,
    input: { url: string; description?: string | null; eventTypes: readonly string[] },
    deps: GuardDeps & { env?: Record<string, string | undefined> } = {},
  ) {
    assertHumanWebhookManager(actor);
    const keyring = requireKeyring(deps.env ?? process.env);
    const eventTypes = normaliseEventTypes(input.eventTypes);
    const description = cleanDescription(input.description);
    const url = await assertDeliverableUrl(input.url, deps);

    const id = randomUUID();
    const secret = generateSigningSecret();
    const encrypted = encryptSecret(secret, { organizationId: actor.organizationId, subscriptionId: id }, keyring);

    const created = await withTenant(actor.organizationId, async (tx) => {
      // Serialise concurrent creates for this organization so the per-organization cap cannot be raced past.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`webhook-subscriptions:${actor.organizationId}`}))`);
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.organizationId, actor.organizationId));
      if (count >= MAX_SUBSCRIPTIONS_PER_ORG) {
        throw new InvalidWebhookInputError(`An organization can have at most ${MAX_SUBSCRIPTIONS_PER_ORG} webhook subscriptions. Delete one you no longer use.`);
      }
      const [row] = await tx
        .insert(webhookSubscriptions)
        .values({
          id,
          organizationId: actor.organizationId,
          url,
          description,
          eventTypes,
          createdByUserId: actor.userId,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
        })
        .returning();
      if (!row) throw new Error("Failed to create webhook subscription.");
      await AuditService.record(tx, actor, {
        action: "webhook_subscription.created",
        entityType: "WebhookSubscription",
        entityId: row.id,
        after: auditView(row),
      });
      return row;
    });
    /** The ONLY time the signing secret exists outside the encrypted column. Show it once; it cannot be retrieved again. */
    return { subscription: summarise(created, null, new Date()), secret };
  },

  async list(actor: Actor, now: Date = new Date()): Promise<WebhookSubscriptionSummary[]> {
    assertHumanWebhookManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({ sub: webhookSubscriptions, createdByName: users.name })
        .from(webhookSubscriptions)
        .leftJoin(users, eq(users.id, webhookSubscriptions.createdByUserId))
        .where(eq(webhookSubscriptions.organizationId, actor.organizationId))
        .orderBy(desc(webhookSubscriptions.createdAt), desc(webhookSubscriptions.id));
      return rows.map((r) => summarise(r.sub, r.createdByName, now));
    });
  },

  async update(
    actor: Actor,
    subscriptionId: string,
    input: { url?: string; description?: string | null; eventTypes?: readonly string[] },
    deps: GuardDeps = {},
  ) {
    assertHumanWebhookManager(actor);
    const eventTypes = input.eventTypes ? normaliseEventTypes(input.eventTypes) : undefined;
    const description = input.description !== undefined ? cleanDescription(input.description) : undefined;
    const url = input.url !== undefined ? await assertDeliverableUrl(input.url, deps) : undefined;

    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new WebhookNotFoundError();
      const [row] = await tx
        .update(webhookSubscriptions)
        .set({
          url: url ?? existing.url,
          description: description !== undefined ? description : existing.description,
          eventTypes: eventTypes ?? existing.eventTypes,
          updatedAt: new Date(),
        })
        .where(eq(webhookSubscriptions.id, subscriptionId))
        .returning();
      if (!row) throw new WebhookNotFoundError();
      await AuditService.record(tx, actor, {
        action: "webhook_subscription.updated",
        entityType: "WebhookSubscription",
        entityId: subscriptionId,
        before: auditView(existing),
        after: auditView(row),
      });
      return summarise(row, null, new Date());
    });
  },

  /** Pause / resume. Resuming a DISABLED (auto-disabled) subscription resets its failure counter. */
  async setStatus(actor: Actor, subscriptionId: string, status: "ACTIVE" | "PAUSED") {
    assertHumanWebhookManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new WebhookNotFoundError();
      if (existing.status === status) return summarise(existing, null, new Date());
      const [row] = await tx
        .update(webhookSubscriptions)
        .set({
          status,
          statusReason: status === "PAUSED" ? "Paused by a person." : null,
          consecutiveFailures: status === "ACTIVE" ? 0 : existing.consecutiveFailures,
          updatedAt: new Date(),
        })
        .where(eq(webhookSubscriptions.id, subscriptionId))
        .returning();
      if (!row) throw new WebhookNotFoundError();
      await AuditService.record(tx, actor, {
        action: status === "ACTIVE" ? (existing.status === "DISABLED" ? "webhook_subscription.re_enabled" : "webhook_subscription.resumed") : "webhook_subscription.paused",
        entityType: "WebhookSubscription",
        entityId: subscriptionId,
        before: { status: existing.status, statusReason: existing.statusReason, consecutiveFailures: existing.consecutiveFailures },
        after: { status: row.status, consecutiveFailures: row.consecutiveFailures },
      });
      return summarise(row, null, new Date());
    });
  },

  /**
   * Issues a new signing secret. The old one keeps working for ROTATION_GRACE_HOURS: deliveries carry a `v1=` signature for
   * both, so a consumer switches without downtime. Rotating again inside the window replaces the old one outright.
   */
  async rotateSecret(actor: Actor, subscriptionId: string, deps: { env?: Record<string, string | undefined> } = {}, now: Date = new Date()) {
    assertHumanWebhookManager(actor);
    const keyring = requireKeyring(deps.env ?? process.env);
    const secret = generateSigningSecret();
    const encrypted = encryptSecret(secret, { organizationId: actor.organizationId, subscriptionId }, keyring);
    const graceUntil = new Date(now.getTime() + ROTATION_GRACE_HOURS * 3_600_000);

    await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new WebhookNotFoundError();
      await tx
        .update(webhookSubscriptions)
        .set({
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
          // The old ciphertext is bound to this same (organization, subscription) pair, so it moves across unchanged.
          previousSecretCiphertext: existing.secretCiphertext,
          previousSecretKeyVersion: existing.secretKeyVersion,
          previousSecretExpiresAt: graceUntil,
          updatedAt: now,
        })
        .where(eq(webhookSubscriptions.id, subscriptionId));
      await AuditService.record(tx, actor, {
        action: "webhook_subscription.secret_rotated",
        entityType: "WebhookSubscription",
        entityId: subscriptionId,
        // No secret, no ciphertext: only the fact and the grace window.
        after: { rotated: true, previousSecretValidUntil: graceUntil },
      });
    });
    return { secret, previousSecretValidUntil: graceUntil };
  },

  /** Deletes a subscription and (by cascade) its deliveries and attempt log. */
  async remove(actor: Actor, subscriptionId: string) {
    assertHumanWebhookManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new WebhookNotFoundError();
      await tx.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
      await AuditService.record(tx, actor, {
        action: "webhook_subscription.deleted",
        entityType: "WebhookSubscription",
        entityId: subscriptionId,
        before: auditView(existing),
      });
      return { id: subscriptionId };
    });
  },
};
