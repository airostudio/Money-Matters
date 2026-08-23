import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { deleteDraftAction, postDraftAction, reverseEntryAction } from "../actions";

export default async function JournalEntryDetailPage({
  params,
}: {
  params: { orgSlug: string; entryId: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const entry = await LedgerService.getJournalEntry(actor, params.entryId);
  if (!entry) notFound();

  const canPost = roleHasPermission(actor.role, "journal:post");
  const canReverse = roleHasPermission(actor.role, "journal:reverse");

  const boundPostDraft = postDraftAction.bind(null, org.slug, entry.id);
  const boundDeleteDraft = deleteDraftAction.bind(null, org.slug, entry.id);
  const boundReverse = reverseEntryAction.bind(null, org.slug, entry.id);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{entry.entryNumber}</h1>
            <StatusBadge status={entry.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {new Date(entry.postingDate).toLocaleDateString("en-AU", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
            {entry.memo && <> · {entry.memo}</>}
          </p>
          {entry.reversalOf && (
            <p className="mt-1 text-sm">
              Reverses{" "}
              <Link
                href={`/${org.slug}/accounting/journals/${entry.reversalOf.id}`}
                className="text-primary hover:underline"
              >
                {entry.reversalOf.entryNumber}
              </Link>
            </p>
          )}
          {entry.reversedBy && (
            <p className="mt-1 text-sm">
              Reversed by{" "}
              <Link
                href={`/${org.slug}/accounting/journals/${entry.reversedBy.id}`}
                className="text-primary hover:underline"
              >
                {entry.reversedBy.entryNumber}
              </Link>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {entry.status === "DRAFT" && canPost && (
            <>
              <form action={boundDeleteDraft}>
                <Button type="submit" variant="outline" size="sm">
                  Delete draft
                </Button>
              </form>
              <form action={boundPostDraft}>
                <Button type="submit" size="sm">
                  Post
                </Button>
              </form>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Account</th>
                <th className="px-6 py-2 font-medium">Memo</th>
                <th className="px-6 py-2 text-right font-medium">Debit</th>
                <th className="px-6 py-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entry.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">
                    <span className="font-mono text-xs text-muted-foreground">{line.account.code}</span>{" "}
                    {line.account.name}
                  </td>
                  <td className="px-6 py-2.5 text-muted-foreground">{line.memo || "—"}</td>
                  <td className="px-6 py-2.5 text-right">
                    {line.debit !== "0.0000" && <MoneyDisplay amount={line.debit} currency={line.currency} />}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    {line.credit !== "0.0000" && <MoneyDisplay amount={line.credit} currency={line.currency} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {entry.status === "POSTED" && canReverse && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reverse this entry</CardTitle>
          </CardHeader>
          <form action={boundReverse}>
            <CardContent className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <label htmlFor="reason" className="text-sm font-medium">
                  Reason
                </label>
                <Input id="reason" name="reason" placeholder="e.g. duplicate entry, wrong account" required />
              </div>
              <Button type="submit" variant="outline">
                Reverse entry
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
