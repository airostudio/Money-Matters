import Link from "next/link";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The friendly "this company is archived" state. Shown to MEMBERS of an archived company only (a non-member still gets
 * a plain 404, exactly as for a company that does not exist). Nothing about the company's data is rendered: just that
 * it is archived and, for an OWNER, the way back.
 */
export function ArchivedCompanyNotice({
  orgId,
  orgName,
  archivedAt,
  reason,
  canRestore,
  restoreAction,
}: {
  orgId: string;
  orgName: string;
  archivedAt: Date | null;
  /** Only passed for an OWNER. */
  reason?: string | null;
  canRestore: boolean;
  restoreAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <div role="status" className="space-y-4 rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Archive className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold tracking-tight">This company is archived</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{orgName}</span> was archived
          {archivedAt ? ` on ${archivedAt.toISOString().slice(0, 10)}` : ""}. Nobody can view or change its books, and its
          API keys, webhooks and automations are paused, until an owner restores it. Nothing has been deleted.
        </p>
        {canRestore && reason && <p className="text-xs text-muted-foreground">Reason recorded: {reason}</p>}
        {canRestore ? (
          <form action={restoreAction} className="flex items-center gap-3">
            <input type="hidden" name="organizationId" value={orgId} />
            <Button type="submit">Restore this company</Button>
            <Link href="/app" className="text-sm text-primary underline">
              Choose another company
            </Link>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an owner of {orgName} to restore it.{" "}
            <Link href="/app" className="text-primary underline">
              Choose another company
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
