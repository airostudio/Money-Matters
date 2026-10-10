import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { IntegrationService, MAX_CONNECTIONS_PER_ORG, integrationEncryptionStatus, type ConnectionSummary } from "@/domain/integrations/connection-service";
import { listCatalog } from "@/domain/integrations/registry";
import { CATEGORY_LABELS } from "@/domain/integrations/provider";
import { SLACK_ALLOWED_HOSTS } from "@/domain/integrations/providers/slack-incoming-webhook";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConnectSlackForm } from "@/components/shell/connect-slack-form";
import { connectSlackAction, disconnectAction, reconnectAction, removeConnectionAction, testConnectionAction, updateConnectionSettingsAction } from "./actions";

const STATUS_STYLES: Record<ConnectionSummary["status"], string> = {
  CONNECTED: "bg-success/15 text-success",
  ERROR: "bg-destructive/10 text-destructive",
  DISCONNECTED: "bg-muted text-muted-foreground",
};

function formatTime(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "never";
}

function noticeText(code: string | undefined, errorClass: string | undefined): { tone: "ok" | "warn"; text: string } | null {
  const cls = (errorClass ?? "").replace(/[^a-z_]/g, "").slice(0, 30).replace(/_/g, " ");
  switch (code) {
    case "connected":
      return { tone: "ok", text: "Connected. Send a test message to confirm it reaches the channel." };
    case "reconnected":
      return { tone: "ok", text: "Reconnected with the new address." };
    case "test_ok":
      return { tone: "ok", text: "Test message sent. Check the channel." };
    case "test_failed":
      return { tone: "warn", text: `The test message was not delivered${cls ? ` (${cls})` : ""}. The connection is marked as having an error until a test succeeds.` };
    case "test_refused":
      return { tone: "warn", text: "A test could not be run: the connection is disconnected or the platform key is not set." };
    case "disconnected":
      return { tone: "ok", text: "Disconnected. The stored address was erased." };
    case "removed":
      return { tone: "ok", text: "Removed." };
    case "saved":
      return { tone: "ok", text: "Saved." };
    default:
      return null;
  }
}

/**
 * Integrations (Phase 10 Slice 3, master spec s.53): the framework's management page. Only an Owner or Administrator
 * (`integration:manage`) sees anything here. The one working provider is a Slack-compatible incoming webhook; everything
 * else is listed as "coming soon" and cannot be connected. No stored secret is ever rendered.
 */
export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { notice?: string; class?: string };
}) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "integration:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can manage integrations.</p>
      </div>
    );
  }

  const encryption = integrationEncryptionStatus();
  const connections = await IntegrationService.list(actor);
  const log = await IntegrationService.recentEventsForAll(actor, 60);
  const catalog = listCatalog();
  const notice = noticeText(searchParams.notice, searchParams.class);
  const boundConnect = connectSlackAction.bind(null, org.slug);
  const boundTest = testConnectionAction.bind(null, org.slug);
  const boundDisconnect = disconnectAction.bind(null, org.slug);
  const boundRemove = removeConnectionAction.bind(null, org.slug);
  const boundSettings = updateConnectionSettingsAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect {org.name} to outside services. Today one is available: posting automation messages to Slack. The rest of the list is on the roadmap and needs accounts and credentials that this installation does not have yet.
        </p>
      </div>

      {!encryption.configured && (
        <p role="alert" data-testid="integrations-disabled" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <span className="font-medium">Integrations are turned off on this installation.</span> The platform operator has not set up the key that protects stored credentials ({encryption.reason}). Nothing can be connected or sent until it is set;
          the rest of Money Matters, including automations that do not send to a channel, is unaffected.
        </p>
      )}
      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-success/10 text-success" : "bg-warning/15"}`}>
          {notice.text}
        </p>
      )}

      {encryption.configured && connections.length < MAX_CONNECTIONS_PER_ORG && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect Slack</CardTitle>
            <CardDescription>
              In Slack, create an incoming webhook for the channel and paste its address here. Only {SLACK_ALLOWED_HOSTS.join(", ")} is accepted, over https. Money Matters sends short text messages only - no files, no replies, no reading of your Slack.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectSlackForm action={boundConnect} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your connections</CardTitle>
          <CardDescription>
            {connections.length} of {MAX_CONNECTIONS_PER_ORG}. Rules that send to a channel (Settings, Automation) use these.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {connections.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing connected yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="connection-list">
              {connections.map((c) => {
                const entries = log.filter((e) => e.connectionId === c.id).slice(0, 5);
                return (
                  <li key={c.id} className="space-y-2 px-6 py-4 text-sm" data-testid="connection-item">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {c.name} <span className="text-muted-foreground">- {c.providerName}</span>{" "}
                          <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status]}`}>{c.status}</span>
                        </p>
                        {typeof c.publicConfig.maskedUrl === "string" && c.status !== "DISCONNECTED" && (
                          <p className="font-mono text-xs text-muted-foreground" data-testid="masked-url">
                            {c.publicConfig.maskedUrl}
                          </p>
                        )}
                        {c.statusReason && c.status !== "CONNECTED" && <p className="text-xs text-destructive">{c.statusReason}</p>}
                        <p className="text-xs text-muted-foreground">
                          Last checked {formatTime(c.lastCheckedAt)}
                          {c.lastError ? ` - last problem: ${c.lastError}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {c.status !== "DISCONNECTED" && (
                          <form action={boundTest}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <Button type="submit" size="sm" variant="secondary" disabled={!encryption.configured}>
                              Send test message
                            </Button>
                          </form>
                        )}
                        {c.status !== "DISCONNECTED" ? (
                          <form action={boundDisconnect}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <Button type="submit" size="sm" variant="destructive">
                              Disconnect
                            </Button>
                          </form>
                        ) : (
                          <form action={boundRemove}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <Button type="submit" size="sm" variant="destructive">
                              Remove
                            </Button>
                          </form>
                        )}
                      </div>
                    </div>
                    {c.status !== "DISCONNECTED" && (
                      <form action={boundSettings} className="flex items-center gap-3 text-xs">
                        <input type="hidden" name="connectionId" value={c.id} />
                        <label className="flex items-center gap-2">
                          <input type="checkbox" name="includeAmounts" defaultChecked={c.publicConfig.includeAmounts === true} /> Include amounts in messages
                        </label>
                        <Button type="submit" size="sm" variant="secondary">
                          Save
                        </Button>
                      </form>
                    )}
                    {encryption.configured && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-primary">{c.status === "DISCONNECTED" ? "Reconnect with a new address" : "Replace the address"}</summary>
                        <div className="mt-3">
                          <ConnectSlackForm action={reconnectAction.bind(null, org.slug, c.id)} withName={false} idle="Replace address" />
                        </div>
                      </details>
                    )}
                    {entries.length > 0 && (
                      <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="connection-log">
                        {entries.map((e) => (
                          <li key={e.id}>
                            {formatTime(e.createdAt)} - {e.kind.toLowerCase()} - {e.ok ? "ok" : "failed"}
                            {e.detail ? `: ${e.detail}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="provider-catalog">
        <CardHeader>
          <CardTitle className="text-base">Available and coming soon</CardTitle>
          <CardDescription>Nothing below &quot;Available&quot; works yet. They are listed so you can see where the platform is going; none of them can be connected today.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {catalog.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 px-6 py-3 text-sm" data-testid={`catalog-${p.id}`}>
                <div className="min-w-0">
                  <p className="font-medium">
                    {p.name} <span className="text-xs font-normal text-muted-foreground">{CATEGORY_LABELS[p.category]}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                  {p.needs && <p className="text-xs text-muted-foreground">{p.needs}</p>}
                </div>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${p.availability === "AVAILABLE" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{p.availability === "AVAILABLE" ? "Available" : "Coming soon"}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
