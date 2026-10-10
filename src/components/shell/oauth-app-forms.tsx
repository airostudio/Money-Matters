"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateOAuthAppState, RotateOAuthSecretState } from "@/app/[orgSlug]/settings/oauth-apps/actions";

export interface OAuthScopeOption {
  scope: string;
  label: string;
  description: string;
  write: boolean;
}

function Submit({ label, pending: pendingLabel, variant }: { label: string; pending: string; variant?: "default" | "destructive" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant} size={variant ? "sm" : "default"}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function SecretBox({ title, secret, testId }: { title: string; secret: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" data-testid={testId} className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-4 text-sm">
      <p className="font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">It is shown only once and only a fingerprint is kept, so it cannot be shown again. Keep it on the app&apos;s server; never put it in a browser, a mobile app or a repository.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <code data-testid={`${testId}-value`} className="block flex-1 overflow-x-auto whitespace-nowrap rounded border border-border bg-background px-3 py-2 font-mono text-xs">
          {secret}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** Scope picker shared by the create and edit forms. */
export function ScopePicker({ scopes, selected, onToggle, idPrefix }: { scopes: OAuthScopeOption[]; selected: Set<string>; onToggle?: (scope: string) => void; idPrefix: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">The most this app may ever ask for</legend>
      <p className="text-xs text-muted-foreground">
        Each person who connects the app chooses to allow it (or not) and can only grant what their own role allows. These are the same scopes as API keys; none of them can post, approve, pay or delete.
      </p>
      <div className="divide-y divide-border rounded-md border border-border">
        {scopes.map((s) => (
          <label key={s.scope} htmlFor={`${idPrefix}-${s.scope}`} className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm">
            <input
              id={`${idPrefix}-${s.scope}`}
              type="checkbox"
              name="scopes"
              value={s.scope}
              {...(onToggle ? { checked: selected.has(s.scope), onChange: () => onToggle(s.scope) } : { defaultChecked: selected.has(s.scope) })}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{s.label}</span> <code className="text-xs text-muted-foreground">{s.scope}</code>
              {s.write && <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 text-xs font-medium">creates drafts</span>}
              <br />
              <span className="text-xs text-muted-foreground">{s.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateOAuthAppForm({
  action,
  scopes,
}: {
  action: (previous: CreateOAuthAppState, formData: FormData) => Promise<CreateOAuthAppState>;
  scopes: OAuthScopeOption[];
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as CreateOAuthAppState);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (scope: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });

  return (
    <div className="space-y-4">
      {state.status === "created" && (
        <div className="space-y-3" data-testid="new-oauth-app">
          <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
            Registered &ldquo;{state.name}&rdquo;. Client ID: <code className="font-mono text-xs">{state.clientId}</code>
          </p>
          {state.clientSecret ? (
            <SecretBox title="Copy the client secret now." secret={state.clientSecret} testId="new-oauth-secret" />
          ) : (
            <p className="text-xs text-muted-foreground">This is a public app: it has no client secret and relies on PKCE alone.</p>
          )}
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <form action={formAction} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="oauth-name">App name</Label>
            <Input id="oauth-name" name="name" placeholder="e.g. Acme Expense Sync" maxLength={80} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oauth-homepage">Homepage (optional)</Label>
            <Input id="oauth-homepage" name="homepageUrl" type="url" placeholder="https://app.example.com" maxLength={300} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="oauth-description">Description (optional, shown on the consent screen)</Label>
          <Input id="oauth-description" name="description" maxLength={300} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="oauth-redirects">Redirect URIs (one per line)</Label>
          <textarea
            id="oauth-redirects"
            name="redirectUris"
            required
            rows={3}
            placeholder="https://app.example.com/oauth/callback"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">Exact addresses only: https, or http://localhost / 127.0.0.1 for local development (any port). No wildcards, no fragments.</p>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">App type</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="clientType" value="CONFIDENTIAL" defaultChecked className="mt-1" />
            <span>
              <span className="font-medium">Confidential</span> - runs on a server that can keep a secret. You get a client secret, shown once.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="clientType" value="PUBLIC" className="mt-1" />
            <span>
              <span className="font-medium">Public</span> - a native or single-page app that cannot keep a secret. No secret; protected by PKCE.
            </span>
          </label>
        </fieldset>
        <ScopePicker scopes={scopes} selected={selected} onToggle={toggle} idPrefix="oauth-new" />
        <Submit label="Register app" pending="Registering..." />
      </form>
    </div>
  );
}

export function RotateSecretForm({
  action,
  appId,
}: {
  action: (previous: RotateOAuthSecretState, formData: FormData) => Promise<RotateOAuthSecretState>;
  appId: string;
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as RotateOAuthSecretState);
  return (
    <div className="space-y-2">
      <form action={formAction}>
        <input type="hidden" name="appId" value={appId} />
        <Submit label="Rotate secret" pending="Rotating..." variant="secondary" />
      </form>
      {state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      )}
      {state.status === "rotated" && <SecretBox title="New client secret. The old one has stopped working." secret={state.clientSecret} testId="rotated-oauth-secret" />}
    </div>
  );
}
