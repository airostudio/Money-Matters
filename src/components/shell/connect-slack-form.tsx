"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectFormState } from "@/app/[orgSlug]/settings/integrations/actions";

function Submit({ idle }: { idle: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking..." : idle}
    </Button>
  );
}

/**
 * Connect (or reconnect) a Slack incoming webhook. The URL is a bearer secret, so the field is a password input that is
 * never pre-filled; the page never renders a stored URL, only a masked tail.
 */
export function ConnectSlackForm({
  action,
  withName = true,
  idle = "Connect Slack",
}: {
  action: (previous: ConnectFormState, formData: FormData) => Promise<ConnectFormState>;
  withName?: boolean;
  idle?: string;
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as ConnectFormState);
  return (
    <form action={formAction} className="space-y-4" data-testid="connect-slack-form" autoComplete="off">
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {withName && (
          <div className="space-y-2">
            <Label htmlFor="slack-name">Name</Label>
            <Input id="slack-name" name="name" maxLength={60} required placeholder="e.g. #finance alerts" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="slack-url">Slack incoming webhook URL</Label>
          <Input id="slack-url" name="webhookUrl" type="password" autoComplete="off" spellCheck={false} maxLength={512} required placeholder="https://hooks.slack.com/services/..." />
          <p className="text-xs text-muted-foreground">Only hooks.slack.com addresses are accepted. We store it encrypted and never show it again.</p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="slack-label">Channel label (optional)</Label>
        <Input id="slack-label" name="channelLabel" maxLength={60} placeholder="Shown to you only" />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="includeAmounts" className="mt-1" />
        <span>
          Include amounts in messages
          <span className="block text-xs text-muted-foreground">Off by default. Messages then say what happened and link back, without figures.</span>
        </span>
      </label>
      <Submit idle={idle} />
    </form>
  );
}
