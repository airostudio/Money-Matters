import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { organizationMemberships, products, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { IntegrationService } from "@/domain/integrations/connection-service";
import type { ChannelMessage, OperationResult } from "@/domain/integrations/provider";
import { NotificationService } from "@/domain/notifications/notification-service";
import { assertPermission } from "@/domain/permissions/permission-service";
import { roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { DomainEventService } from "@/domain/webhooks/domain-events";
import { sanitiseError } from "@/domain/webhooks/sanitize";
import type { OutboundDeps } from "@/domain/webhooks/outbound";
import { appBaseUrl, describeSubject } from "./messages";
import type { OrgInfo, Outcome, PassDeps, PassSource, PlannedJob } from "./engine-types";
import { finishIn } from "./run-recording";
import { MAX_SEND_ATTEMPTS, TRIGGER_READ_PERMISSIONS, retryDelayMs, startOfUtcDay, type RuleAction } from "./vocabulary";

/**
 * The four automation actions. Each is a short, bounded piece of work that records its own run (see `finishIn`) in the
 * SAME transaction as its effect. Each runs as the rule's `AUTOMATION` actor, so every domain service it touches checks the
 * narrowed permission set and refuses anything outside it.
 *
 * Only `SEND_TO_CHANNEL` does network I/O, and it does so with NO transaction open: read plan (tx) -> send -> record (tx).
 * An exception inside an action never escapes: `execute` turns it into a FAILED run.
 */
export interface Env {
  org: OrgInfo;
  source: PassSource;
  deps: PassDeps;
  /** Tallies each recorded outcome for the pass summary. */
  onOutcome: (outcome: Outcome["outcome"]) => void;
}

const now = (deps: PassDeps) => (deps.now ?? (() => new Date()))();

function actionOf(planned: PlannedJob): RuleAction {
  return planned.rule.spec.action;
}

async function notifyInApp(planned: PlannedJob, env: Env, startedAt: Date): Promise<void> {
  const action = actionOf(planned);
  if (action.type !== "NOTIFY_IN_APP") throw new Error("wrong action");
  const { rule, context } = planned;
  const organizationId = rule.row.organizationId;
  await withTenant(organizationId, async (tx) => {
    assertPermission(rule.actor, "automation:read");
    const filters = [];
    if (action.roles.length > 0) filters.push(inArray(organizationMemberships.role, action.roles as MembershipRole[]));
    if (action.userIds.length > 0) filters.push(inArray(organizationMemberships.userId, action.userIds));
    const members = await tx
      .select({ userId: organizationMemberships.userId, role: organizationMemberships.role })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true), isNull(users.disabledAt), or(...filters)));
    // A person is notified only if their role could look at the object themselves: a rule never reveals what its audience could not see.
    const readPermission = TRIGGER_READ_PERMISSIONS[planned.rule.spec.trigger];
    const recipients = members.filter((m) => roleHasPermission(m.role, readPermission)).map((m) => m.userId);
    const t = now(env.deps);
    let outcome: Outcome;
    if (recipients.length === 0) {
      outcome = { outcome: "SKIPPED", reason: "No eligible recipients: nobody matching this rule is an active member whose role can see this item." };
    } else {
      const described = describeSubject(context, env.org.slug, rule.row.name, action.message);
      const body = action.includeAmounts && described.amountLine ? `${described.body} ${described.amountLine}.` : described.body;
      const count = await NotificationService.createIn(
        tx,
        organizationId,
        recipients,
        { title: described.title, body, link: described.path, severity: action.severity, source: "automation", sourceRefId: rule.row.id },
        t,
      );
      outcome = { outcome: "SUCCESS", note: `Notified ${count} ${count === 1 ? "person" : "people"}.` };
    }
    await finishIn(tx, planned, outcome, { source: env.source, startedAt, now: t });
    env.onOutcome(outcome.outcome);
  });
}

async function emitWebhookEvent(planned: PlannedJob, env: Env, startedAt: Date): Promise<void> {
  const { rule, context } = planned;
  const organizationId = rule.row.organizationId;
  await withTenant(organizationId, async (tx) => {
    assertPermission(rule.actor, "automation:read");
    // Payload = rule identity + trigger + the subject's PUBLIC API DTO (or just its id): never anything the API does not expose.
    const eventId = await DomainEventService.emitIn(tx, organizationId, {
      type: "automation.triggered",
      aggregateType: "AutomationRule",
      aggregateId: rule.row.id,
      origin: "automation",
      object: {
        rule: { id: rule.row.id, name: rule.row.name },
        trigger: rule.row.trigger,
        subject: { type: context.objectType, id: context.objectId },
        object: context.dto,
      },
    });
    await finishIn(tx, planned, { outcome: "SUCCESS", created: { type: "DomainEvent", id: eventId }, note: "Emitted an automation.triggered event." }, { source: env.source, startedAt, now: now(env.deps) });
    env.onOutcome("SUCCESS");
  });
}

async function createDraftPurchaseOrder(planned: PlannedJob, env: Env, startedAt: Date): Promise<void> {
  const { rule, context } = planned;
  const organizationId = rule.row.organizationId;
  await withTenant(organizationId, async (tx) => {
    const t = now(env.deps);
    const finish = async (outcome: Outcome) => {
      await finishIn(tx, planned, outcome, { source: env.source, startedAt, now: t });
      env.onOutcome(outcome.outcome);
    };
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, context.objectId), eq(products.organizationId, organizationId)));
    if (!p || p.type !== "TRACKED_INVENTORY" || !p.isActive || p.reorderPoint === null) {
      await finish({ outcome: "SKIPPED", reason: "The product is no longer an active tracked product with a reorder point." });
      return;
    }
    // Re-check at the moment of acting: stock may have been received since the scan.
    if (Number(p.quantityOnHand) > Number(p.reorderPoint)) {
      await finish({ outcome: "SKIPPED", reason: "Stock recovered above the reorder point before the order was drafted." });
      return;
    }
    if (!p.preferredSupplierContactId) {
      await finish({ outcome: "SKIPPED", reason: `${p.name} has no preferred supplier. Set one on the product; the rule will draft an order the next time stock falls to the reorder point.` });
      return;
    }
    if (p.reorderQuantity === null || Number(p.reorderQuantity) <= 0) {
      await finish({ outcome: "SKIPPED", reason: `${p.name} has no reorder quantity. Set one on the product; the rule will draft an order the next time stock falls to the reorder point.` });
      return;
    }
    if (!p.inventoryAssetAccountId) {
      await finish({ outcome: "SKIPPED", reason: `${p.name} has no inventory asset account.` });
      return;
    }
    let created: { id: string; poNumber: string };
    try {
      // A SAVEPOINT: if the purchase-order service refuses (inactive supplier, inactive account), only the attempt is undone.
      created = await tx.transaction((sp) =>
        PurchaseOrderService.createIn(sp, rule.actor, {
          supplierContactId: p.preferredSupplierContactId as string,
          issueDate: startOfUtcDay(t),
          currency: env.org.baseCurrency,
          memo: `Drafted by automation rule "${rule.row.name}" - review before sending.`,
          lines: [{ description: `${p.name} (${p.sku})`, quantity: p.reorderQuantity as string, unitPrice: p.averageUnitCost, accountId: p.inventoryAssetAccountId as string }],
        }),
      );
    } catch (error) {
      await finish({ outcome: "SKIPPED", reason: `The purchase order could not be drafted: ${sanitiseError((error as Error).message)}` });
      return;
    }
    await finish({ outcome: "SUCCESS", created: { type: "PurchaseOrder", id: created.id }, note: `Drafted purchase order ${created.poNumber} (still a draft).` });
  });
}

async function sendToChannel(planned: PlannedJob, env: Env, startedAt: Date): Promise<void> {
  const action = actionOf(planned);
  if (action.type !== "SEND_TO_CHANNEL") throw new Error("wrong action");
  const { rule, context } = planned;
  const organizationId = rule.row.organizationId;
  const record = async (outcome: Outcome) => {
    await withTenant(organizationId, (tx) => finishIn(tx, planned, outcome, { source: env.source, startedAt, now: now(env.deps) }));
    env.onOutcome(outcome.outcome);
  };

  // tx 1: read the plan (no I/O inside).
  const prepared = await withTenant(organizationId, async (tx) => {
    assertPermission(rule.actor, "automation:read");
    return IntegrationService.prepareSendIn(tx, organizationId, action.connectionId);
  });
  if (!prepared.ok) {
    await record({ outcome: "FAILED", reason: prepared.reason });
    return;
  }

  const described = describeSubject(context, env.org.slug, rule.row.name, action.message);
  const base = env.deps.baseUrl !== undefined ? env.deps.baseUrl : appBaseUrl(env.deps.env ?? process.env);
  const message: ChannelMessage = {
    title: described.title,
    body: described.body,
    linkUrl: base ? `${base}${described.path}` : null,
    severity: "INFO",
    amountLine: described.amountLine,
  };

  // The network call: NO transaction or connection is held here.
  env.deps.onSend?.();
  const outboundDeps: OutboundDeps & { env?: Record<string, string | undefined> } = { resolver: env.deps.resolver, transport: env.deps.transport, classify: env.deps.classify, timeoutMs: env.deps.timeoutMs, maxResponseBytes: env.deps.maxResponseBytes, env: env.deps.env };
  const result: OperationResult = await IntegrationService.sendWithPlan(organizationId, prepared.plan, message, outboundDeps);

  // tx 2: record the send, the run, the job and the counters together.
  const t = now(env.deps);
  await withTenant(organizationId, async (tx) => {
    await IntegrationService.recordSendIn(tx, rule.actor, action.connectionId, result, rule.row.id, t);
    const attempt = planned.attemptsMade + 1;
    let outcome: Outcome;
    if (result.ok) outcome = { outcome: "SUCCESS", note: "Message sent to the channel." };
    else if (attempt < MAX_SEND_ATTEMPTS && result.errorClass !== "ssrf_blocked" && result.errorClass !== "encryption_unavailable") {
      outcome = { outcome: "FAILED", reason: `Send attempt ${attempt} of ${MAX_SEND_ATTEMPTS} failed: ${result.message}`, retryAt: new Date(t.getTime() + retryDelayMs(attempt)) };
    } else outcome = { outcome: "FAILED", reason: `Send failed${attempt >= MAX_SEND_ATTEMPTS ? ` after ${attempt} attempts` : ""}: ${result.message}` };
    await finishIn(tx, planned, outcome, { source: env.source, startedAt, now: t });
    env.onOutcome(outcome.outcome);
  });
}

/** Runs one planned job. Never throws: an unexpected error becomes a FAILED run (recorded in a fresh short transaction). */
export async function executeJob(planned: PlannedJob, env: Env): Promise<void> {
  const startedAt = now(env.deps);
  try {
    switch (planned.rule.spec.action.type) {
      case "NOTIFY_IN_APP":
        await notifyInApp(planned, env, startedAt);
        break;
      case "EMIT_WEBHOOK_EVENT":
        await emitWebhookEvent(planned, env, startedAt);
        break;
      case "CREATE_DRAFT_PURCHASE_ORDER":
        await createDraftPurchaseOrder(planned, env, startedAt);
        break;
      case "SEND_TO_CHANNEL":
        await sendToChannel(planned, env, startedAt);
        break;
    }
  } catch (error) {
    try {
      const reason = `Unexpected error: ${(error as Error).name === "PermissionDeniedError" ? "the rule's authoriser no longer has permission for this action." : sanitiseError((error as Error).message ?? "error")}`;
      await withTenant(planned.rule.row.organizationId, (tx) => finishIn(tx, planned, { outcome: "FAILED", reason }, { source: env.source, startedAt, now: now(env.deps) }));
      env.onOutcome("FAILED");
    } catch {
      // The database itself is unavailable: the job keeps its lease and is picked up again when the lease expires.
    }
  }
}
