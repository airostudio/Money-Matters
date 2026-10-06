"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateApiKeyState } from "@/app/[orgSlug]/settings/api/actions";

export interface ScopeOption {
  scope: string;
  label: string;
  description: string;
  write: boolean;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create API key"}
    </Button>
  );
}

/**
 * Create-an-API-key form. The secret comes back in the action's RESPONSE (`useFormState`), is shown exactly once in
 * this component's state with a copy button, and is never in a URL or storage. Write scopes carry a plain warning:
 * they let the integration create DRAFT documents (a person still posts them).
 */
export function CreateApiKeyForm({
  action,
  scopes,
  defaultRateLimit,
  minRateLimit,
  maxRateLimit,
}: {
  action: (previous: CreateApiKeyState, formData: FormData) => Promise<CreateApiKeyState>;
  scopes: ScopeOption[];
  defaultRateLimit: number;
  minRateLimit: number;
  maxRateLimit: number;
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as CreateApiKeyState);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const writeSelected = scopes.some((s) => s.write && selected.has(s.scope));

  function toggle(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {state.status === "created" && (
        <div role="status" data-testid="new-api-key" className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-4 text-sm">
          <p className="font-medium">
            Copy your new key now. For security it is shown only once - it cannot be shown again, and we do not store it.
          </p>
          <p className="text-xs text-muted-foreground">
            Key &ldquo;{state.name}&rdquo; (prefix <code>{state.prefix}</code>). Keep it on a server; never put it in a browser, an app or a repository.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <code data-testid="new-api-key-secret" className="block flex-1 overflow-x-auto whitespace-nowrap rounded border border-border bg-background px-3 py-2 font-mono text-xs">
              {state.secret}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(state.secret).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}

      <form action={formAction} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-1">
            <Label htmlFor="api-key-name">Name</Label>
            <Input id="api-key-name" name="name" placeholder="e.g. Warehouse sync" maxLength={80} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-expires">Expires on (optional)</Label>
            <Input id="api-key-expires" name="expiresOn" type="date" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-rate">Requests per minute (optional)</Label>
            <Input id="api-key-rate" name="rateLimit" type="number" min={minRateLimit} max={maxRateLimit} step={1} placeholder={String(defaultRateLimit)} />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What may this key do?</legend>
          <p className="text-xs text-muted-foreground">
            A key can only ever do what its scopes allow <em>and</em> what you, its creator, can currently do in this organization. If your role is reduced or you are removed, the key shrinks or stops working immediately.
          </p>
          <div className="divide-y divide-border rounded-md border border-border">
            {scopes.map((s) => (
              <label key={s.scope} className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm">
                <input type="checkbox" name="scopes" value={s.scope} checked={selected.has(s.scope)} onChange={() => toggle(s.scope)} className="mt-1" />
                <span>
                  <span className="font-medium">{s.label}</span>{" "}
                  <code className="text-xs text-muted-foreground">{s.scope}</code>
                  {s.write && <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 text-xs font-medium">creates drafts</span>}
                  <br />
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {writeSelected && (
          <p role="note" data-testid="write-scope-warning" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs">
            <span className="font-medium">Write scopes let this integration create draft documents</span> (invoices, bills, customers, suppliers) in {" "}
            your books. Drafts have no effect on the ledger until a person reviews and posts them in Money Matters - the API can never post, approve, void, pay or delete anything.
          </p>
        )}

        <SubmitButton />
      </form>
    </div>
  );
}
