import Link from "next/link";
import { notFound } from "next/navigation";
import { requireGroupUser } from "../../require-user";
import { AdjustmentService } from "@/domain/consolidation/adjustment-service";
import { GroupService } from "@/domain/consolidation/group-service";
import { GroupNotFoundError } from "@/domain/consolidation/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/domain/money/money";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { createAdjustmentAction, reverseAdjustmentAction } from "../../actions";

export default async function GroupAdjustmentsPage({ params, searchParams }: { params: { groupId: string }; searchParams: { error?: string } }) {
  const { actor } = await requireGroupUser();

  let detail;
  let adjustments;
  try {
    detail = await GroupService.get(actor, params.groupId);
    adjustments = await AdjustmentService.list(actor, params.groupId);
  } catch (error) {
    if (error instanceof GroupNotFoundError) notFound();
    throw error;
  }
  const accounts = detail.config.groupAccounts;
  const currency = detail.members.find((m) => m.accessible && m.baseCurrency)?.baseCurrency ?? "AUD";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/app/groups" className="hover:underline">
            Entity groups
          </Link>{" "}
          /{" "}
          <Link href={`/app/groups/${params.groupId}`} className="hover:underline">
            {detail.group.name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Consolidation adjustments</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Manual elimination and adjustment journals that exist <strong>only at group level</strong>, against group accounts. They appear in the
          consolidated reports&apos; &ldquo;Elim. &amp; adj.&rdquo; column and are <strong>never posted into any entity&apos;s ledger</strong> or trial balance.
          They are permanent: undo one by reversing it, which adds a new mirror-image row.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New adjustment</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createAdjustmentAction.bind(null, params.groupId)} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <select name="kind" className="h-9 rounded-md border border-input bg-background px-3 text-sm" defaultValue="ADJUSTMENT">
                <option value="ADJUSTMENT">Adjustment</option>
                <option value="ELIMINATION">Elimination</option>
              </select>
              <Input type="date" name="effectiveDate" required defaultValue={today} />
              <Input name="description" required placeholder="Description" className="sm:col-span-2" />
            </div>
            <Input name="reason" required placeholder="Why — required and kept forever" />
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_2fr]">
                  <select name={`account-${i}`} className="h-9 rounded-md border border-input bg-background px-3 text-sm" defaultValue="">
                    <option value="">{i < 2 ? "Account…" : "Account (optional)…"}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                  <Input name={`debit-${i}`} placeholder="Debit" inputMode="decimal" />
                  <Input name={`credit-${i}`} placeholder="Credit" inputMode="decimal" />
                  <Input name={`memo-${i}`} placeholder="Line memo (optional)" />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Debits and credits must balance exactly (at most 4 decimal places).</p>
            <Button type="submit">Record adjustment</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History ({adjustments.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {adjustments.length === 0 && <p className="text-sm text-muted-foreground">No adjustments yet.</p>}
          {adjustments.map((a) => (
            <div key={a.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {a.description}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      {a.kind.toLowerCase()} · effective {a.effectiveDate.toISOString().slice(0, 10)}
                      {a.reversesAdjustmentId && " · reversal"}
                      {a.reversedById && " · REVERSED"}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">Reason: {a.reason}</p>
                </div>
                {!a.reversedById && !a.reversesAdjustmentId && (
                  <form action={reverseAdjustmentAction.bind(null, params.groupId, a.id)} className="flex items-center gap-2">
                    <Input name="reason" required placeholder="Reason for reversal" className="h-8 w-48 text-xs" />
                    <Button type="submit" size="sm" variant="outline">
                      Reverse
                    </Button>
                  </form>
                )}
              </div>
              <ul className="mt-2 text-xs text-muted-foreground">
                {a.lines.map((l, i) => (
                  <li key={i}>
                    {Money.of(l.debit, currency).isPositive() ? "Dr" : "Cr"} {l.account?.code} {l.account?.name} —{" "}
                    <MoneyDisplay amount={Money.of(l.debit, currency).isPositive() ? l.debit : l.credit} currency={currency} className="text-xs" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
