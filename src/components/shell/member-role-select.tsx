"use client";

import { useRef } from "react";
import { membershipRoleEnum } from "@/db/schema";

export function MemberRoleSelect({
  membershipId,
  currentRole,
  disabled,
  action,
}: {
  membershipId: string;
  currentRole: string;
  disabled?: boolean;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={action}>
      <input type="hidden" name="membershipId" value={membershipId} />
      <select
        name="role"
        defaultValue={currentRole}
        onChange={() => formRef.current?.requestSubmit()}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        disabled={disabled}
      >
        {membershipRoleEnum.enumValues.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
    </form>
  );
}
