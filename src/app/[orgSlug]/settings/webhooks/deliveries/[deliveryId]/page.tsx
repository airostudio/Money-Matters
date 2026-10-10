import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { getDeliveryWithAttempts } from "@/domain/webhooks/delivery-queries";
import { WebhookNotFoundError } from "@/domain/webhooks/subscription-service";
import { webhookEncryptionStatus } from "@/domain/webhooks/secret-crypto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { replayDeliveryAction } from "../../actions";
import { noticeText } from "../../notices";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formatTime = (date: Date | null) => (date ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : "-");

/** A delivery's attempt history. Response excerpts are untrusted text from the customer's server: truncated and control-stripped when stored, rendered as plain text here. */
export default async function DeliveryPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; deliveryId: string };
  searchParams: { notice?: string; status?: string; sent?: string; failed?: string; class?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);
  if (!roleHasPermission(actor.role, "webhook:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Webhook delivery</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can manage webhooks.</p>
      </div>
    );
  }
  if (!UUID.test(params.deliveryId)) notFound();

  let detail;
  try {
    detail = await getDeliveryWithAttempts(actor, params.deliveryId);
  } catch (error) {
    if (error instanceof WebhookNotFoundError) notFound();
    throw error;
  }
  const { delivery, attempts } = detail;
  const notice = noticeText(searchParams);
  const boundReplay = replayDeliveryAction.bind(null, org.slug, delivery.id);
  const canReplay = webhookEncryptionStatus().configured;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings/webhooks/${delivery.subscriptionId}`} className="hover:underline">
            Back to deliveries
          </Link>
        </p>
        <h1 className="text-xl font-semibold tracking-tight">
          <code>{delivery.eventType}</code> to <span className="break-all">{delivery.subscriptionUrl}</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          {delivery.status} - {delivery.attemptCount} attempt(s) - event <code className="text-xs">{delivery.eventId}</code> (the id your endpoint should de-duplicate on)
          {delivery.status === "PENDING" && delivery.nextAttemptAt ? ` - next automatic attempt ${formatTime(delivery.nextAttemptAt)}` : ""}
        </p>
      </div>

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15"}`}>
          {notice.text}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Replay</CardTitle>
          <CardDescription>Send this event again right now as a fresh attempt. It is recorded below as a replay by you, and does not use up the automatic retry schedule.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={boundReplay}>
            <Button type="submit" size="sm" disabled={!canReplay}>
              Replay delivery
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attempt history</CardTitle>
          <CardDescription>Append-only: attempts cannot be edited or removed.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-border" data-testid="attempt-list">
            {attempts.map((a) => (
              <li key={`${a.attemptNumber}-${a.startedAt.toISOString()}`} className="space-y-1 px-6 py-3 text-sm">
                <p>
                  <span className="font-medium">#{a.attemptNumber}</span> - {formatTime(a.startedAt)} - {a.durationMs} ms -{" "}
                  {a.statusCode ? `HTTP ${a.statusCode}` : a.errorClass ? `error: ${a.errorClass.replace(/_/g, " ")}` : "no response"} -{" "}
                  <span className="text-muted-foreground">
                    {a.trigger === "REPLAY" ? `replayed by ${a.triggeredByName ?? "a person"}` : a.trigger === "TEST" ? `test event by ${a.triggeredByName ?? "a person"}` : "automatic"}
                  </span>
                </p>
                {a.responseExcerpt && <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{a.responseExcerpt}</pre>}
              </li>
            ))}
            {attempts.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No attempt has been made yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
