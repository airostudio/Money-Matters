"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The "Danger zone" archive form. Archiving is REVERSIBLE (an owner restores from the company chooser) and deletes
 * nothing - but it closes the company to everyone and pauses API keys, webhooks and automations, so it asks for the
 * company name typed exactly, an explicit acknowledgement and a reason. The button staying disabled until the name
 * matches is a convenience; the server (OrganizationLifecycleService.archive) re-checks every one of these.
 */
export function ArchiveCompanyForm({
  action,
  orgName,
  orgSlug,
}: {
  action: (formData: FormData) => void | Promise<void>;
  orgName: string;
  orgSlug: string;
}) {
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const ready = typed.trim() === orgName && ack && reason.trim().length >= 5;

  return (
    <form action={action} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Before you archive, consider exporting your reports (they will not be reachable while archived):{" "}
        <Link href={`/${orgSlug}/accounting/reports/profit-and-loss`} className="text-primary underline">
          Profit &amp; loss
        </Link>
        ,{" "}
        <Link href={`/${orgSlug}/accounting/reports/balance-sheet`} className="text-primary underline">
          Balance sheet
        </Link>
        ,{" "}
        <Link href={`/${orgSlug}/accounting/reports/cash-flow`} className="text-primary underline">
          Cash flow
        </Link>{" "}
        (each has a CSV export).
      </p>
      <div className="space-y-2">
        <Label htmlFor="archive-confirm-name">
          Type the company name <span className="font-mono">{orgName}</span> to confirm
        </Label>
        <Input
          id="archive-confirm-name"
          name="confirmName"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="archive-reason">Reason</Label>
        <Input
          id="archive-reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Business closed at end of financial year"
          maxLength={500}
          required
        />
      </div>
      <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <input
          type="checkbox"
          name="acknowledge"
          value="true"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          required
          className="mt-1"
        />
        <span>
          I understand that <strong>everyone loses access</strong> to this company, and that its <strong>webhooks, API keys and
          automations stop</strong>, until an owner restores it. Nothing is deleted.
        </span>
      </label>
      <Button type="submit" variant="destructive" disabled={!ready}>
        Archive this company
      </Button>
    </form>
  );
}
