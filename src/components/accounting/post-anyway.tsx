import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MIN_REASON_LENGTH } from "@/domain/ledger/period-lock";

/**
 * "Post anyway — reason required": offered when a posting was rejected by a
 * SOFT lock the current user is authorised to override (master spec §41/§77).
 * The reason is the only thing the client supplies; the server decides
 * whether the user's role may use it, records the override on the journal
 * entry, and appends it to the period's lock history and the audit log.
 */
export function PostAnywayForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="text-base">Post anyway — reason required</CardTitle>
      </CardHeader>
      <form action={action}>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This period is soft-locked. Your role can still post into it, but the reason below is recorded on the entry,
            in the period&apos;s lock history and in the audit log.
          </p>
          <div className="space-y-2">
            <Label htmlFor="lockOverrideReason">Reason (at least {MIN_REASON_LENGTH} characters)</Label>
            <textarea
              id="lockOverrideReason"
              name="lockOverrideReason"
              required
              minLength={MIN_REASON_LENGTH}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="e.g. late supplier invoice for September"
            />
          </div>
          <Button type="submit" size="sm">
            Post anyway
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
