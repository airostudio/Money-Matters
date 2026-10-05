import { requireOrgAndActor } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createBudgetAction } from "../actions";

export default async function NewBudgetPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { org } = await requireOrgAndActor(params.orgSlug);
  const action = createBudgetAction.bind(null, org.slug);

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New budget</h1>
        <p className="text-sm text-muted-foreground">
          Create a baseline budget, a revised forecast, or a rolling forecast. Lines are added afterwards, a whole
          account&apos;s year at once.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {searchParams.error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="FY2026 Baseline" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="type">Type</Label>
              <select
                id="type"
                name="type"
                defaultValue="BASELINE"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="BASELINE">Baseline</option>
                <option value="REVISED_FORECAST">Revised Forecast</option>
              </select>
              <p className="text-xs text-muted-foreground">
                A Rolling Forecast is created from an existing budget&apos;s detail page, not here.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="periodStart">Period start</Label>
                <Input type="date" id="periodStart" name="periodStart" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="periodEnd">Period end</Label>
                <Input type="date" id="periodEnd" name="periodEnd" required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={3} />
            </div>
            <Button type="submit">Create budget</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
