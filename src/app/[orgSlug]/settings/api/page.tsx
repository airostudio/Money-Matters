import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ApiKeyService, type ApiKeyStatus } from "@/domain/api/api-key-service";
import { API_SCOPES, SCOPE_INFO } from "@/domain/api/scopes";
import { DEFAULT_RATE_LIMIT_PER_MINUTE, MAX_RATE_LIMIT_PER_MINUTE, MIN_RATE_LIMIT_PER_MINUTE } from "@/domain/api/rate-limit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CreateApiKeyForm } from "@/components/shell/create-api-key-form";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

const STATUS_STYLES: Record<ApiKeyStatus, string> = {
  ACTIVE: "bg-success/15 text-success",
  REVOKED: "bg-destructive/10 text-destructive",
  EXPIRED: "bg-muted text-muted-foreground",
};

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "-";
}

/**
 * API access (Phase 10 Slice 1): create and revoke API keys for server-to-server integrations. Only an Owner or
 * Administrator (`api_key:manage`) can see or change anything here - everyone else gets an explanation, not a
 * broken page. No secret is ever rendered by this page: the secret exists only in the response to the create
 * action, once.
 */
export default async function ApiAccessPage({ params }: { params: { orgSlug: string } }) {
  const { org, actor } = await requireOrgAndActor(params.orgSlug);

  if (!roleHasPermission(actor.role, "api_key:manage")) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">API access</h1>
        <p className="text-sm text-muted-foreground">Only an Owner or Administrator of {org.name} can create and manage API keys.</p>
      </div>
    );
  }

  const keys = await ApiKeyService.list(actor);
  const scopeOptions = API_SCOPES.map((s) => ({ scope: s, label: SCOPE_INFO[s].label, description: SCOPE_INFO[s].description, write: SCOPE_INFO[s].write }));
  const boundCreate = createApiKeyAction.bind(null, org.slug);
  const boundRevoke = revokeApiKeyAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/settings`} className="hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">API access</h1>
        <p className="text-sm text-muted-foreground">
          API keys let an approved server integration read {org.name}&apos;s data and create <strong>draft</strong> invoices, bills, customers and suppliers. They can never post, approve, void, pay or delete
          anything, and they cannot touch payroll, closing periods, team access or these settings.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create an API key</CardTitle>
          <CardDescription>
            The key is shown once, here, and only its fingerprint is kept. It acts with your current permissions at most: it is limited to the scopes you tick and to what you can do now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateApiKeyForm
            action={boundCreate}
            scopes={scopeOptions}
            defaultRateLimit={DEFAULT_RATE_LIMIT_PER_MINUTE}
            minRateLimit={MIN_RATE_LIMIT_PER_MINUTE}
            maxRateLimit={MAX_RATE_LIMIT_PER_MINUTE}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your API keys</CardTitle>
          <CardDescription>Revoking a key takes effect on its very next request.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {keys.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="api-key-list">
              {keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 text-sm">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">
                      {key.name}{" "}
                      <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[key.status]}`}>{key.status}</span>
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">mm_live_{key.prefix}_••••••••</p>
                    <p className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <code key={scope} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {scope}
                        </code>
                      ))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDate(key.createdAt)} by {key.createdByName ?? "a former member"} - last used {formatDate(key.lastUsedAt)} - expires {formatDate(key.expiresAt)} - {key.rateLimitPerMinute} requests/minute
                    </p>
                  </div>
                  {key.status === "ACTIVE" && (
                    <form action={boundRevoke}>
                      <input type="hidden" name="keyId" value={key.id} />
                      <Button type="submit" size="sm" variant="destructive">
                        Revoke
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Using the API</CardTitle>
          <CardDescription>
            Server-to-server only: keep keys on a server (browsers are not supported - there is no CORS). Send the key as a bearer token and read the full reference in the{" "}
            <a href="/api/v1/openapi.json" className="text-primary underline">
              OpenAPI document
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`curl https://YOUR-DOMAIN/api/v1/me \\
  -H "Authorization: Bearer mm_live_<prefix>_<secret>"

curl https://YOUR-DOMAIN/api/v1/invoices \\
  -X POST -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"customer_id":"...","issue_date":"2026-03-10","due_date":"2026-04-10","currency":"AUD",
       "ar_account_id":"...","lines":[{"description":"Consulting","quantity":"2","unit_price":"150.00","account_id":"..."}]}'`}</pre>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Money is a decimal string with a currency, e.g. <code>{`{"amount":"150.00","currency":"AUD"}`}</code>. Totals and tax are always calculated by us.</li>
            <li>
              Creating an invoice or bill needs an <code>Idempotency-Key</code> header, so a retried request can never create a duplicate.
            </li>
            <li>
              {DEFAULT_RATE_LIMIT_PER_MINUTE} requests per minute per key by default; responses carry <code>X-RateLimit-*</code> headers and a 429 carries <code>Retry-After</code>.
            </li>
            <li>
              Drafts created through the API appear under <Link href={`/${org.slug}/sales/invoices`} className="text-primary underline">Sales</Link> and <Link href={`/${org.slug}/purchases/bills`} className="text-primary underline">Purchases</Link> as normal drafts for a person to review and post.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
