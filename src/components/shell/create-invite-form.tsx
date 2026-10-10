"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoleOption } from "@/domain/permissions/role-info";
import type { CreateInviteState } from "@/app/[orgSlug]/settings/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create code"}
    </Button>
  );
}

/**
 * "Create an invite code": email + role (Read only preselected, with the same plain-language role description and the
 * explicit write-access confirmation as the add-by-email form - the server re-checks it). Same pattern as the API-key
 * form: the code comes back in the server action's RESPONSE (`useFormState`), never from a URL, and is shown ONCE. Only a
 * hash is stored, so it cannot be shown again; leaving the page loses it by design.
 */
export function CreateInviteForm({
  action,
  options,
  defaultRole,
}: {
  action: (previous: CreateInviteState, formData: FormData) => Promise<CreateInviteState>;
  options: RoleOption[];
  defaultRole: string;
}) {
  const [state, formAction] = useFormState(action, { status: "idle" } as CreateInviteState);
  const [role, setRole] = useState(defaultRole);
  const selected = options.find((o) => o.role === role) ?? options[0]!;

  return (
    <div className="space-y-4 px-6 pb-6">
      {state.status === "created" && (
        <div role="status" className="space-y-2 rounded-md border border-success/40 bg-success/10 px-3 py-3 text-sm">
          <p className="font-medium">Invite code for {state.email}</p>
          <p className="break-all rounded bg-background px-2 py-1 font-mono text-sm" data-testid="invite-code">
            {state.code}
          </p>
          <p className="text-xs text-muted-foreground">
            Copy it now - it is shown only once and cannot be recovered (only a fingerprint is stored). Send it to them through a
            channel you trust. It works once, only for an account registered with {state.email}, and expires on{" "}
            {state.expiresAt.slice(0, 10)}. They enter it under &quot;Join a company&quot; after signing in, or on the sign-up form.
            Creating another code or leaving this page hides this one.
          </p>
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      <form action={formAction} className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="invite-email">Invitee&apos;s email</Label>
            <Input id="invite-email" name="email" type="email" placeholder="teammate@example.com" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="flex h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
            >
              {options.map((o) => (
                <option key={o.role} value={o.role}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <SubmitButton />
        </div>
        <div className="space-y-1 rounded-md bg-muted/60 px-3 py-2 text-sm">
          <p>
            <span className="font-medium">{selected.label}.</span> {selected.description}
          </p>
          {selected.canChange.length === 0 && <p className="text-xs text-muted-foreground">Cannot change anything in the books.</p>}
        </div>
        {selected.needsWriteConfirmation && (
          <label className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            <input type="checkbox" name="confirmWriteAccess" value="true" required className="mt-1" />
            <span>I understand this person will be able to edit financial data.</span>
          </label>
        )}
      </form>
    </div>
  );
}
