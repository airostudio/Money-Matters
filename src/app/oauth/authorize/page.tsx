import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { authorize, parseAuthorizeParams, type RawParams } from "@/domain/oauth/authorize-service";
import { signConsentToken } from "@/domain/oauth/csrf";
import { issuerFor } from "@/domain/oauth/metadata";
import { OAUTH_ERROR_MESSAGES, type OAuthErrorReason } from "../error-messages";

export const dynamic = "force-dynamic";

/**
 * The OAuth authorization endpoint (RFC 6749 section 3.1) and consent screen. Authorization decisions live in
 * src/domain/oauth/authorize-service.ts; this page only renders them:
 *  - a signed-out visitor is sent to /login and brought back here (the same safe `next` the whole app uses);
 *  - an untrustworthy client / redirect URI renders an ERROR PAGE (this page never redirects to an unregistered URI);
 *  - a malformed-but-attributable request is returned to the app's own registered redirect URI as `error=...`;
 *  - otherwise the person sees the consent screen. It is ALWAYS shown: there is no first-party trust, no `prompt=none`
 *    and no remembered approval that skips it. Allow / Deny POST to ./decision with a CSRF token bound to this request.
 * Framing is refused for the whole site (X-Frame-Options: DENY + CSP frame-ancestors 'none', next.config.mjs).
 */
function ErrorCard({ reason }: { reason: OAuthErrorReason }) {
  const message = OAUTH_ERROR_MESSAGES[reason];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{message.title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{message.body}</CardContent>
    </Card>
  );
}

function currentUrl(raw: RawParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  return `/oauth/authorize?${query.toString()}`;
}

function requestIssuer(): string {
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return issuerFor(`${proto}://${host}/`);
}

export default async function AuthorizePage({ searchParams }: { searchParams: RawParams }) {
  if (!parseAuthorizeParams(searchParams)) return <ErrorCard reason="invalid_request" />;

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(currentUrl(searchParams))}`);

  const outcome = await authorize({ id: user.id }, searchParams, "preview", requestIssuer());
  if (outcome.kind === "error_page") return <ErrorCard reason={outcome.reason} />;
  if (outcome.kind === "redirect") redirect(outcome.url);
  if (outcome.kind !== "consent") return <ErrorCard reason="invalid_request" />;

  const { view } = outcome;
  const csrf = signConsentToken(user.id, view.request);
  const reads = view.scopes.filter((s) => !s.write);
  const writes = view.scopes.filter((s) => s.write);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {view.app.name} wants access to {view.organization.name}
        </CardTitle>
        <CardDescription>
          You are signed in as <strong>{user.name}</strong> ({user.email}), a <strong>{view.role}</strong> of {view.organization.name}.
          {view.app.description ? <> {view.app.description}</> : null}
        </CardDescription>
      </CardHeader>
      <form method="post" action="/oauth/authorize/decision">
        <CardContent className="space-y-4 text-sm">
          {reads.length > 0 && (
            <div>
              <p className="font-medium">It will be able to read</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {reads.map((s) => (
                  <li key={s.scope}>
                    {s.label}
                    <span className="block text-xs">{s.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {writes.length > 0 && (
            <div>
              <p className="font-medium">It will be able to create drafts</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {writes.map((s) => (
                  <li key={s.scope}>
                    {s.label}
                    <span className="block text-xs">{s.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <p>
              <strong>It can never post, approve, void, pay or delete anything</strong>, change team access, or touch payroll or period close. Anything it creates is a <strong>draft</strong> that a person must review and post in Money Matters.
            </p>
            <p className="mt-2">
              It can only do what your role allows, now and in future: if your role is reduced or you leave {view.organization.name}, it loses that access immediately. You can remove its access at any time under{" "}
              <a href="/app/authorised-apps" className="underline">
                Authorised apps
              </a>
              .
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            After you choose, you will be sent back to <strong>{view.redirectHost}</strong>
            {view.app.homepageUrl ? <> (the app&apos;s website: {view.app.homepageUrl})</> : null}. Only continue if you started this from that app.
          </p>
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="client_id" value={view.request.clientId} />
          <input type="hidden" name="redirect_uri" value={view.request.redirectUri} />
          <input type="hidden" name="scope" value={view.request.scope} />
          <input type="hidden" name="state" value={view.request.state} />
          <input type="hidden" name="code_challenge" value={view.request.codeChallenge} />
          <input type="hidden" name="code_challenge_method" value="S256" />
          <input type="hidden" name="csrf" value={csrf} />
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <Button type="submit" name="decision" value="deny" variant="outline">
            Deny
          </Button>
          <Button type="submit" name="decision" value="allow">
            Allow
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
