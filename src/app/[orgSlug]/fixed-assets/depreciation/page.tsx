import { requireOrgAndActor } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { runDepreciationAction } from "../actions";

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function RunDepreciationPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string; ran?: string; posted?: string };
}) {
  const { org } = await requireOrgAndActor(params.orgSlug);
  const boundRun = runDepreciationAction.bind(null, org.slug);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Run depreciation</h1>
        <p className="text-sm text-muted-foreground">
          There is no automatic/scheduled depreciation in this system yet — this posts straight-line depreciation for
          every active fixed asset for one calendar month, in a single combined journal entry. Running the same
          month twice is a safe no-op: an asset already depreciated for that month is skipped, never double-posted.
        </p>
      </div>

      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      {searchParams.ran ? (
        <p className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-700">
          Ran depreciation for {searchParams.ran.slice(0, 7)} — posted{" "}
          <MoneyDisplay amount={searchParams.posted ?? "0"} currency={org.baseCurrency} /> in total.
          {searchParams.posted === "0.0000" && " Nothing new to depreciate this period."}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run for a month</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={boundRun} className="space-y-4">
            <div>
              <Label htmlFor="periodMonth">Calendar month</Label>
              <Input
                id="periodMonth"
                name="periodMonth"
                type="month"
                required
                defaultValue={currentMonthValue()}
              />
            </div>
            <Button type="submit">Run depreciation</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
