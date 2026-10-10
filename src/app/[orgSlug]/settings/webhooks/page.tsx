import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { WebhookSubscriptionService, MAX_SUBSCRIPTIONS_PER_ORG, ROTATION_GRACE_HOURS, type WebhookSubscriptionStatus } from "@/domain/webhooks/subscription-service";
import { pendingSummary } from "@/domain/webhooks/delivery-queries";
import { EVENT_INFO, EVENT_TYPES } from "@/domain/webhooks/events";
import { webhookEncryptionStatus } from "@/domain/webhooks/secret-crypto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CreateWebhookForm } from "@/components/shell/webhook-forms";
import { createWebhookAction, deleteWebhookAction, sendPendingNowAction, setWebhookStatusAction } from "./actions";
import { noticeText } from "./notices";

const STATUS_STYLES: Record<WebhookSubscriptionStatus, string> = {
  ACTIVE: "bg-success/15 text-success",
  PAUSED: "bg-muted text-muted-foreground",
  DISABLED: "bg-destructive/10 text-destructive",
};

function formatTime(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "never";
}

/**
 * Webhooks (Phase 10 Slice 2): register endpoints that receive signed events, see the delivery log, send a test event,
 * and trigger delivery now. Only an Owner or Administrator (`webhook:manage`) sees anything here. No signing secret is ever
 * rendered by this page: it exists only in the response to the create / rotate action, once.
 */
export default async function WebhooksPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { notice?: string; status?: string; sent?: string; failed?: string; class?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "webhook:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can manage webhooks.</p>
      </div>
    );
  }

  const encryption = webhookEncryptionStatus();
  const subscriptions = await WebhookSubscriptionService.list(actor);
  const pending = await pendingSummary(actor);
  const notice = noticeText(searchParams);
  const options = EVENT_TYPES.map((t) => ({ type: t, label: EVENT_INFO[t].label, description: EVENT_INFO[t].description }));
  // Events committed before any webhook exists have nobody to go to; only count work when an ACTIVE subscription could receive it.
  const hasActive = subscriptions.some((s) => s.status === "ACTIVE");
  const waiting = hasActive ? pending.undispatchedEvents + pending.dueNow : pending.dueNow;

  const boundCreate = createWebhookAction.bind(null, org.slug);
  const boundSetStatus = setWebhookStatusAction.bind(null, org.slug);
  const boundDelete = deleteWebhookAction.bind(null, org.slug);
  const boundSendNow = sendPendingNowAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="text-sm text-muted-foreground">
          Webhooks send a signed event to your server when something happens in {org.name} - an invoice is created or paid, a payment arrives, a bill is approved, a customer is added. Events carry exactly what the public API
          returns for that object, nothing more. Delivery is at least once: your server should de-duplicate on the event id.
        </p>
      </div>

      {!encryption.configured && (
        <p role="alert" data-testid="webhooks-disabled" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <span className="font-medium">Webhooks are turned off on this installation.</span> The platform operator has not set up the key that protects signing secrets ({encryption.reason}). Nothing can be created or sent until
          it is set; the rest of Money Matters is unaffected, and events that happen meanwhile wait safely.
        </p>
      )}

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15"}`}>
          {notice.text}
        </p>
      )}

      {(waiting > 0 || pending.scheduledLater > 0 || pending.failed > 0) && (
        <Card data-testid="webhooks-pending">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
            <div className="space-y-1">
              {waiting > 0 && (
                <p className="font-medium">
                  {waiting} event{waiting === 1 ? "" : "s"} pending delivery.
                </p>
              )}
              {pending.scheduledLater > 0 && <p className="text-muted-foreground">{pending.scheduledLater} failed delivery(ies) are waiting for their next retry.</p>}
              {pending.failed > 0 && <p className="text-muted-foreground">{pending.failed} delivery(ies) gave up after repeated failures; open a subscription to replay them.</p>}
              <p className="text-xs text-muted-foreground">There is no background scheduler: events are sent right after the change that created them, and again whenever you press Send now.</p>
            </div>
            {waiting > 0 && encryption.configured && (
              <form action={boundSendNow}>
                <Button type="submit" size="sm">
                  Send now
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {encryption.configured && subscriptions.length < MAX_SUBSCRIPTIONS_PER_ORG && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a webhook</CardTitle>
            <CardDescription>
              Up to {MAX_SUBSCRIPTIONS_PER_ORG} per organization. The signing secret is shown once, here; we keep it encrypted and cannot show it again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateWebhookForm action={boundCreate} options={options} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your webhooks</CardTitle>
          <CardDescription>
            A webhook that fails 20 deliveries in a row is switched off automatically (re-enable it once your endpoint is fixed).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {subscriptions.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No webhooks yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="webhook-list">
              {subscriptions.map((s) => (
                <li key={s.id} className="space-y-2 px-6 py-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="break-all font-medium">
                        <Link href={`/${org.slug}/settings/webhooks/${s.id}`} className="hover:underline">
                          {s.url}
                        </Link>{" "}
                        <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]}`}>{s.status}</span>
                      </p>
                      {s.description && <p className="text-muted-foreground">{s.description}</p>}
                      <p className="flex flex-wrap gap-1">
                        {s.eventTypes.map((t) => (
                          <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {t}
                          </code>
                        ))}
                      </p>
                      {s.statusReason && s.status !== "ACTIVE" && <p className="text-xs text-destructive">{s.statusReason}</p>}
                      <p className="text-xs text-muted-foreground">
                        Last success {formatTime(s.lastSuccessAt)} - last failure {formatTime(s.lastFailureAt)} - {s.consecutiveFailures} consecutive failure(s)
                        {s.rotationGraceUntil && ` - previous secret still accepted until ${formatTime(s.rotationGraceUntil)}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/${org.slug}/settings/webhooks/${s.id}`} className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs hover:bg-accent">
                        Deliveries
                      </Link>
                      {s.status !== "DISABLED" && (
                        <form action={boundSetStatus}>
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <input type="hidden" name="status" value={s.status === "ACTIVE" ? "PAUSED" : "ACTIVE"} />
                          <Button type="submit" size="sm" variant="secondary">
                            {s.status === "ACTIVE" ? "Pause" : "Resume"}
                          </Button>
                        </form>
                      )}
                      {s.status === "DISABLED" && (
                        <form action={boundSetStatus}>
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <input type="hidden" name="status" value="ACTIVE" />
                          <Button type="submit" size="sm">
                            Re-enable
                          </Button>
                        </form>
                      )}
                      <form action={boundDelete}>
                        <input type="hidden" name="subscriptionId" value={s.id} />
                        <Button type="submit" size="sm" variant="destructive">
                          Delete
                        </Button>
                      </form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Verifying deliveries</CardTitle>
          <CardDescription>
            Every request carries <code>Mm-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, an HMAC-SHA256 of <code>&quot;&lt;t&gt;.&lt;raw body&gt;&quot;</code> with your signing secret. Reject deliveries whose timestamp is more than 5 minutes
            old, and de-duplicate on <code>Mm-Event-Id</code>. Rotating a secret keeps the old one valid for {ROTATION_GRACE_HOURS} hours. Full guide with Node.js and Python snippets: <code>docs/api.md</code> (Webhooks).
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
