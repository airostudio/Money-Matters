import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { WebhookSubscriptionService, ROTATION_GRACE_HOURS } from "@/domain/webhooks/subscription-service";
import { listRecentDeliveries } from "@/domain/webhooks/delivery-queries";
import { EVENT_INFO, EVENT_TYPES } from "@/domain/webhooks/events";
import { webhookEncryptionStatus } from "@/domain/webhooks/secret-crypto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EventTypeChecklist, RotateSecretForm } from "@/components/shell/webhook-forms";
import { rotateSecretAction, sendTestEventAction, updateWebhookAction } from "../actions";
import { noticeText } from "../notices";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DELIVERY_STYLES = {
  DELIVERED: "bg-success/15 text-success",
  PENDING: "bg-warning/20",
  FAILED: "bg-destructive/10 text-destructive",
} as const;

function formatTime(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : "-";
}

/** One subscription: edit it, send a test event, rotate its secret, and read its recent deliveries (drill in for attempts, replay). */
export default async function WebhookDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; subscriptionId: string };
  searchParams: { notice?: string; status?: string; sent?: string; failed?: string; class?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  if (!roleHasPermission(actor.role, "webhook:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Webhook</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can manage webhooks.</p>
      </div>
    );
  }
  if (!UUID.test(params.subscriptionId)) notFound();

  const subscription = (await WebhookSubscriptionService.list(actor)).find((s) => s.id === params.subscriptionId);
  if (!subscription) notFound();
  const deliveries = await listRecentDeliveries(actor, subscription.id);
  const encryption = webhookEncryptionStatus();
  const notice = noticeText(searchParams);
  const options = EVENT_TYPES.map((t) => ({ type: t, label: EVENT_INFO[t].label, description: EVENT_INFO[t].description }));

  const boundUpdate = updateWebhookAction.bind(null, org.slug, subscription.id);
  const boundTest = sendTestEventAction.bind(null, org.slug, subscription.id);
  const boundRotate = rotateSecretAction.bind(null, org.slug, subscription.id);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings/webhooks`} className="hover:underline">
            Webhooks
          </Link>
        </p>
        <h1 className="break-all text-xl font-semibold tracking-tight">{subscription.url}</h1>
        <p className="text-sm text-muted-foreground">
          {subscription.status}
          {subscription.statusReason ? ` - ${subscription.statusReason}` : ""} - created by {subscription.createdByName ?? "a former member"}
        </p>
      </div>

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15"}`}>
          {notice.text}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Test and secret</CardTitle>
          <CardDescription>
            A test event is a signed <code>ping</code> sent right now, so you can confirm your endpoint answers and your signature check passes. It does not count toward the automatic shut-off.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {encryption.configured ? (
            <>
              <form action={boundTest}>
                <Button type="submit" size="sm" disabled={subscription.status === "DISABLED"}>
                  Send test event
                </Button>
              </form>
              <RotateSecretForm action={boundRotate} graceHours={ROTATION_GRACE_HOURS} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Webhooks are turned off on this installation until the platform operator sets the signing-secret key.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={boundUpdate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-url">Endpoint URL</Label>
                <Input id="edit-url" name="url" type="url" defaultValue={subscription.url} maxLength={2048} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <Input id="edit-description" name="description" defaultValue={subscription.description ?? ""} maxLength={200} />
              </div>
            </div>
            <EventTypeChecklist options={options} selected={subscription.eventTypes} />
            <Button type="submit">Save changes</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent deliveries</CardTitle>
          <CardDescription>The latest {deliveries.length} (newest first). Open one for its attempt history and to replay it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {deliveries.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing has been delivered to this webhook yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="delivery-list">
              {deliveries.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                  <div className="space-y-1">
                    <p>
                      <code className="text-xs">{d.eventType}</code>{" "}
                      <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${DELIVERY_STYLES[d.status]}`}>{d.status}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {d.attemptCount} attempt(s) - last HTTP {d.lastStatusCode ?? "-"} {d.lastError ? `- ${d.lastError}` : ""} - created {formatTime(d.createdAt)}
                      {d.status === "PENDING" && d.nextAttemptAt ? ` - next attempt ${formatTime(d.nextAttemptAt)}` : ""}
                    </p>
                  </div>
                  <Link href={`/${org.slug}/settings/webhooks/deliveries/${d.id}`} className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs hover:bg-accent">
                    Details
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
