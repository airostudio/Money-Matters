"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateWebhookState, RotateSecretState } from "@/app/[orgSlug]/settings/webhooks/actions";

export interface EventTypeOption {
  type: string;
  label: string;
  description: string;
}

function Submit({ idle, busy, variant }: { idle: string; busy: string; variant?: "default" | "secondary" | "destructive" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant}>
      {pending ? busy : idle}
    </Button>
  );
}

/** The one-time secret display: shown from the action's RESPONSE only, never stored by the page, gone on reload. */
function SecretReveal({ title, secret, note, testId }: { title: string; secret: string; note: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" data-testid={testId} className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-4 text-sm">
      <p className="font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <code data-testid={`${testId}-secret`} className="block flex-1 overflow-x-auto whitespace-nowrap rounded border border-border bg-background px-3 py-2 font-mono text-xs">
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

export function EventTypeChecklist({ options, selected }: { options: EventTypeOption[]; selected?: string[] }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Which events?</legend>
      <div className="grid gap-1 rounded-md border border-border sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.type} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm">
            <input type="checkbox" name="eventTypes" value={o.type} defaultChecked={selected?.includes(o.type)} className="mt-1" />
            <span>
              <span className="font-medium">{o.label}</span> <code className="text-xs text-muted-foreground">{o.type}</code>
              <br />
              <span className="text-xs text-muted-foreground">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateWebhookForm({
  action,
  options,
}: {
  action: (previous: CreateWebhookState, formData: FormData) => Promise<CreateWebhookState>;
  options: EventTypeOption[];
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as CreateWebhookState);
  return (
    <div className="space-y-4">
      {state.status === "created" && (
        <SecretReveal
          testId="new-webhook-secret"
          title="Copy your signing secret now. For security it is shown only once - we store it encrypted and cannot show it again."
          note={`Endpoint ${state.url}. Use this secret to verify the Mm-Signature header on every delivery (see the verification snippets in the API guide). If you lose it, rotate it.`}
          secret={state.secret}
        />
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <form action={formAction} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <Input id="webhook-url" name="url" type="url" inputMode="url" placeholder="https://example.com/hooks/money-matters" maxLength={2048} required />
            <p className="text-xs text-muted-foreground">Must be https on the standard port, on a public address. Redirects are not followed.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="webhook-description">Description (optional)</Label>
            <Input id="webhook-description" name="description" placeholder="e.g. ERP sync" maxLength={200} />
          </div>
        </div>
        <EventTypeChecklist options={options} />
        <Submit idle="Create webhook" busy="Creating..." />
      </form>
    </div>
  );
}

export function RotateSecretForm({
  action,
  graceHours,
}: {
  action: (previous: RotateSecretState, formData: FormData) => Promise<RotateSecretState>;
  graceHours: number;
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as RotateSecretState);
  return (
    <div className="space-y-3">
      {state.status === "rotated" && (
        <SecretReveal
          testId="rotated-webhook-secret"
          title="Copy your new signing secret now. It is shown only once."
          note={`The old secret keeps working until ${state.validUntil.slice(0, 16).replace("T", " ")} UTC: deliveries carry a signature for both until then, so you can switch over without downtime.`}
          secret={state.secret}
        />
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <Submit idle="Rotate signing secret" busy="Rotating..." variant="secondary" />
        <span className="text-xs text-muted-foreground">The previous secret stays valid for {graceHours} hours.</span>
      </form>
    </div>
  );
}
