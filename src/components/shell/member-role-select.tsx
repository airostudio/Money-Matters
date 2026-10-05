"use client";

import { useRef, useState } from "react";
import type { RoleOption } from "@/domain/permissions/role-info";

/**
 * Change-role control for a team member. Options are ordered least to most
 * privileged (`options` comes from `roleOptions()`), and the selected role's
 * plain-language description is shown beneath. Choosing a role that can change
 * financial data asks for an explicit confirmation before the form is
 * submitted; the server enforces the same rule (OrganizationService), this is
 * only the prompt.
 */
export function MemberRoleSelect({
  membershipId,
  currentRole,
  disabled,
  action,
  options,
}: {
  membershipId: string;
  currentRole: string;
  disabled?: boolean;
  action: (formData: FormData) => void | Promise<void>;
  options: RoleOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(currentRole);
  const [confirmed, setConfirmed] = useState(false);
  const selected = options.find((o) => o.role === value);

  function onChange(next: string) {
    const option = options.find((o) => o.role === next);
    if (option?.needsWriteConfirmation) {
      const ok = window.confirm(
        `Give this person the ${option.label} role?\n\nI understand this person will be able to edit financial data.\n\n${option.description}`,
      );
      if (!ok) return;
      setConfirmed(true);
    } else {
      setConfirmed(false);
    }
    setValue(next);
    // Submit on the next tick so the hidden confirmation field reflects the state just set.
    setTimeout(() => formRef.current?.requestSubmit(), 0);
  }

  return (
    <form ref={formRef} action={action} className="flex max-w-[16rem] flex-col items-end gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="confirmWriteAccess" value={confirmed ? "true" : ""} />
      <select
        name="role"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Role"
        title={selected?.description}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        disabled={disabled}
      >
        {options.map((o) => (
          <option key={o.role} value={o.role}>
            {o.label}
          </option>
        ))}
      </select>
      {selected && <p className="text-right text-[11px] leading-snug text-muted-foreground">{selected.description}</p>}
    </form>
  );
}
