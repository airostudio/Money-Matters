"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoleOption } from "@/domain/permissions/role-info";

/**
 * Add-a-teammate form. READ_ONLY is preselected (the safest role), options run
 * from least to most privileged, the selected role is described in plain
 * language with what it can change and what it can only view (derived from the
 * real permission matrix), and a role that can change financial data - OWNER and
 * ADMINISTRATOR included - requires ticking an explicit confirmation. The
 * server re-checks that confirmation (OrganizationService.addMemberByEmail), so
 * the checkbox is a prompt, not the control.
 */
export function InviteMemberForm({
  action,
  options,
  defaultRole,
  disabled,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: RoleOption[];
  defaultRole: string;
  disabled?: boolean;
}) {
  const [role, setRole] = useState(defaultRole);
  const selected = options.find((o) => o.role === role) ?? options[0]!;

  return (
    <form action={action}>
      <fieldset disabled={disabled} className="space-y-4 px-6 pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" placeholder="teammate@example.com" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <select
              id="role"
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-describedby="role-description"
              className="flex h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
            >
              {options.map((o) => (
                <option key={o.role} value={o.role}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit">Add</Button>
        </div>

        <div id="role-description" className="space-y-1 rounded-md bg-muted/60 px-3 py-2 text-sm" data-testid="role-description">
          <p>
            <span className="font-medium">{selected.label}.</span> {selected.description}
          </p>
          {selected.canChange.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Can change:</span> {selected.canChange.join(", ")}.
            </p>
          )}
          {selected.canOnlyView.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Can only view:</span> {selected.canOnlyView.join(", ")}.
            </p>
          )}
          {selected.canChange.length === 0 && (
            <p className="text-xs text-muted-foreground">Cannot change anything in the books.</p>
          )}
        </div>

        {selected.needsWriteConfirmation && (
          <label className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            <input type="checkbox" name="confirmWriteAccess" value="true" required className="mt-1" />
            <span>I understand this person will be able to edit financial data.</span>
          </label>
        )}
      </fieldset>
    </form>
  );
}
