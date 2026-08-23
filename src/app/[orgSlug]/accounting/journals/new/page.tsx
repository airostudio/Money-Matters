import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JournalLineEditor } from "@/components/accounting/journal-line-editor";
import { postJournalAction, saveDraftAction } from "../actions";

export default async function NewJournalEntryPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const accounts = await AccountService.list(actor);

  const boundPost = postJournalAction.bind(null, org.slug);
  const boundDraft = saveDraftAction.bind(null, org.slug);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>New journal entry</CardTitle>
        </CardHeader>
        <form>
          <CardContent className="space-y-6">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchParams.error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postingDate">Posting date</Label>
                <Input id="postingDate" name="postingDate" type="date" defaultValue={today} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" placeholder="What is this entry for?" />
              </div>
            </div>

            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You need at least one account before you can post a journal entry.
              </p>
            ) : (
              <JournalLineEditor
                accounts={accounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                currency={org.baseCurrency}
              />
            )}
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit" formAction={boundDraft} variant="outline" disabled={accounts.length === 0}>
              Save as draft
            </Button>
            <Button type="submit" formAction={boundPost} disabled={accounts.length === 0}>
              Post
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
