import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { OAuthGrantService, type GrantSummary } from "@/domain/oauth/grant-service";
import { MAX_APPS_PER_ORG } from "@/domain/oauth/constants";
import { API_SCOPES, SCOPE_INFO } from "@/domain/api/scopes";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CreateOAuthAppForm, RotateSecretForm, ScopePicker } from "@/components/shell/oauth-app-forms";
import {
  createOAuthAppAction,
  deleteOAuthAppAction,
  revokeOAuthGrantAction,
  rotateOAuthSecretAction,
  setOAuthAppDisabledAction,
  updateOAuthAppAction,
} from "./actions";

const formatDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "-");

/**
 * Connected apps (Phase 10 Slice 4): register OAuth applications, rotate their secrets, disable or delete them, and see and
 * revoke every authorisation people in this organization have given them. Only an Owner or Administrator
 * (`oauth_app:manage`) sees or changes anything here; everyone else is pointed at "Authorised apps" for their own. No
 * secret is ever rendered by this page: a client secret exists only in the response to the register / rotate actions.
 */
export default async function ConnectedAppsPage({ params, searchParams }: { params: { orgSlug: string }; searchParams: { error?: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "oauth_app:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Connected apps</h1>
        <p className="text-sm text-muted-foreground">
          Only an Owner or Administrator of {org.name} can register and manage OAuth apps. You can see and remove the apps <em>you</em> have authorised under{" "}
          <Link href="/app/authorised-apps" className="text-primary underline">
            Authorised apps
          </Link>
          .
        </p>
      </div>
    );
  }

  const apps = await OAuthAppService.list(actor);
  const grants = await OAuthGrantService.listForOrganization(actor);
  const grantsByApp = new Map<string, GrantSummary[]>();
  for (const g of grants) grantsByApp.set(g.appId, [...(grantsByApp.get(g.appId) ?? []), g]);

  const scopeOptions = API_SCOPES.map((s) => ({ scope: s, label: SCOPE_INFO[s].label, description: SCOPE_INFO[s].description, write: SCOPE_INFO[s].write }));
  const error = typeof searchParams.error === "string" ? searchParams.error.slice(0, 400) : null;

  const boundCreate = createOAuthAppAction.bind(null, org.slug);
  const boundRotate = rotateOAuthSecretAction.bind(null, org.slug);
  const boundUpdate = updateOAuthAppAction.bind(null, org.slug);
  const boundDisable = setOAuthAppDisabledAction.bind(null, org.slug);
  const boundDelete = deleteOAuthAppAction.bind(null, org.slug);
  const boundRevoke = revokeOAuthGrantAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Connected apps</h1>
        <p className="text-sm text-muted-foreground">
          Let a third-party app use {org.name}&apos;s data on behalf of a person who explicitly approves it (OAuth 2.0), instead of sharing an API key. An app registered here can only be connected to <strong>{org.name}</strong>. Whatever it does, it does with the
          approving person&apos;s current role at most, creates <strong>drafts</strong> only, and can never post, approve, pay or delete anything.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Register an app</CardTitle>
          <CardDescription>
            {apps.length} of {MAX_APPS_PER_ORG} apps used. Every person is asked to approve the app on a consent screen the first time; there is no way to pre-approve it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOAuthAppForm action={boundCreate} scopes={scopeOptions} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your apps</CardTitle>
          <CardDescription>Disabling or deleting an app signs it out everywhere at once.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {apps.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No apps registered yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="oauth-app-list">
              {apps.map((a) => {
                const appGrants = grantsByApp.get(a.id) ?? [];
                const selected = new Set(a.scopes);
                return (
                  <li key={a.id} className="space-y-3 px-6 py-4 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {a.name}{" "}
                          <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${a.status === "ACTIVE" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{a.status}</span>{" "}
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.clientType === "PUBLIC" ? "Public" : "Confidential"}</span>
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">client_id {a.clientId}</p>
                        {a.secretPrefix && <p className="font-mono text-xs text-muted-foreground">secret mmo_cs_{a.secretPrefix}_•••••••• (rotated {formatDate(a.secretRotatedAt)})</p>}
                        <p className="flex flex-wrap gap-1">
                          {a.scopes.map((scope) => (
                            <code key={scope} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {scope}
                            </code>
                          ))}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Registered {formatDate(a.createdAt)} by {a.createdByName ?? "a former member"} - {a.activeGrantCount} active authorisation{a.activeGrantCount === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-start gap-2">
                        <form action={boundDisable}>
                          <input type="hidden" name="appId" value={a.id} />
                          <input type="hidden" name="disable" value={a.status === "ACTIVE" ? "true" : "false"} />
                          <Button type="submit" size="sm" variant="secondary">
                            {a.status === "ACTIVE" ? "Disable" : "Enable"}
                          </Button>
                        </form>
                        <form action={boundDelete}>
                          <input type="hidden" name="appId" value={a.id} />
                          <Button type="submit" size="sm" variant="destructive">
                            Delete
                          </Button>
                        </form>
                      </div>
                    </div>

                    {a.clientType === "CONFIDENTIAL" && <RotateSecretForm action={boundRotate} appId={a.id} />}

                    <details className="rounded-md border border-border p-3">
                      <summary className="cursor-pointer text-sm font-medium">Edit details, redirect URIs and scopes</summary>
                      <form action={boundUpdate} className="mt-3 space-y-3">
                        <input type="hidden" name="appId" value={a.id} />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor={`name-${a.id}`}>App name</Label>
                            <Input id={`name-${a.id}`} name="name" defaultValue={a.name} maxLength={80} required />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`home-${a.id}`}>Homepage</Label>
                            <Input id={`home-${a.id}`} name="homepageUrl" type="url" defaultValue={a.homepageUrl ?? ""} maxLength={300} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`desc-${a.id}`}>Description</Label>
                          <Input id={`desc-${a.id}`} name="description" defaultValue={a.description ?? ""} maxLength={300} />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`redir-${a.id}`}>Redirect URIs (one per line)</Label>
                          <textarea id={`redir-${a.id}`} name="redirectUris" rows={3} defaultValue={a.redirectUris.join("\n")} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" />
                        </div>
                        <ScopePicker scopes={scopeOptions} selected={selected} idPrefix={`scopes-${a.id}`} />
                        <p className="text-xs text-muted-foreground">Removing a scope signs out every authorisation that included it.</p>
                        <Button type="submit" size="sm">
                          Save changes
                        </Button>
                      </form>
                    </details>

                    <details className="rounded-md border border-border p-3" open={appGrants.length > 0 && appGrants.length <= 5}>
                      <summary className="cursor-pointer text-sm font-medium">Authorisations ({appGrants.length})</summary>
                      {appGrants.length === 0 ? (
                        <p className="mt-2 text-xs text-muted-foreground">Nobody has connected this app yet.</p>
                      ) : (
                        <ul className="mt-2 divide-y divide-border">
                          {appGrants.map((g) => (
                            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <div className="text-xs">
                                <p className="font-medium">
                                  {g.userName ?? "Unknown"} <span className="text-muted-foreground">({g.userEmail})</span>
                                </p>
                                <p className="text-muted-foreground">
                                  {g.scopes.join(", ")} - connected {formatDate(g.createdAt)}
                                  {g.lastRefreshedAt ? `, last active ${formatDate(g.lastRefreshedAt)}` : ""}
                                </p>
                              </div>
                              <form action={boundRevoke}>
                                <input type="hidden" name="grantId" value={g.id} />
                                <Button type="submit" size="sm" variant="destructive">
                                  Revoke
                                </Button>
                              </form>
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connecting an app</CardTitle>
          <CardDescription>
            Standard OAuth 2.0 authorization code flow with PKCE (S256 required). Discovery document:{" "}
            <a href="/.well-known/oauth-authorization-server" className="text-primary underline">
              /.well-known/oauth-authorization-server
            </a>
            . API reference:{" "}
            <a href="/api/v1/openapi.json" className="text-primary underline">
              OpenAPI
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Send people to <code>/oauth/authorize</code> with <code>response_type=code</code>, <code>client_id</code>, <code>redirect_uri</code>, <code>scope</code>, <code>state</code>, <code>code_challenge</code> and <code>code_challenge_method=S256</code>.
            </li>
            <li>
              Exchange the one-use code (valid 60 seconds) at <code>/api/oauth/token</code>. Access tokens last one hour; refresh tokens rotate on every use, and presenting an old one signs the whole authorisation out.
            </li>
            <li>Tokens are secrets: keep them on the app&apos;s server. Browsers cannot call the token endpoint (no CORS).</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
