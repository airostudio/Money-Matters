import { requireOrgAndActor } from "@/lib/session";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createRollingForecastAction } from "../../actions";

function formatDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function CreateRollingForecastPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; budgetId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const source = await BudgetService.get(actor, params.budgetId);
  if (!source) return <p className="text-sm text-muted-foreground">Budget not found.</p>;

  const action = createRollingForecastAction.bind(null, org.slug, source.id);

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create a rolling forecast</h1>
        <p className="text-sm text-muted-foreground">
          From &ldquo;{source.name}&rdquo; ({formatDate(source.periodStart)} – {formatDate(source.periodEnd)}).
          Every period on or before the carry-forward date is copied through exactly as entered; every period after
          it is carried forward as a starting point for you to edit on the new forecast — the source budget is never
          changed.
        </p>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {searchParams.error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New rolling forecast</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder={`${source.name} (Rolling)`} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="carryForwardAfterDate">Carry forward periods after</Label>
              <Input type="date" id="carryForwardAfterDate" name="carryForwardAfterDate" required />
              <p className="text-xs text-muted-foreground">
                Typically the last day of the most recently closed month — everything up to and including it is
                preserved as actual history; everything after it becomes the new forecast you edit next.
              </p>
            </div>
            <Button type="submit">Create rolling forecast</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
